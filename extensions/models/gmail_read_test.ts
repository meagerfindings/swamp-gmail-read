import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  buildTokenRefreshBody,
  type FetchLike,
  getAllMessageMetadata,
  getMessageMetadata,
  GlobalArgsSchema,
  GMAIL_API_BASE,
  listMessageIds,
  OAUTH_TOKEN_URL,
  parseMessageMetadata,
  randomSuffix,
  redactSecrets,
  refreshAccessToken,
  requireAuth,
  runListUnread,
  toBriefItem,
} from "./gmail_read.ts";

/** Minimal globalArgs fixture with all three auth fields present. */
function authedGlobalArgs(overrides: Partial<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  query: string;
  maxResults: number;
}> = {}) {
  return {
    clientId: "client-123",
    clientSecret: "secret-456",
    refreshToken: "refresh-789",
    query: "is:unread newer_than:1d",
    maxResults: 50,
    ...overrides,
  };
}

/** A fake response object shaped like the injectable FetchLike return type. */
function fakeResponse(
  status: number,
  body: string,
): { ok: boolean; status: number; text: () => Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

Deno.test("requireAuth - throws with a helpful message when creds blank", () => {
  const err = assertThrows(
    () => requireAuth({ clientId: "", clientSecret: "", refreshToken: "" }),
    Error,
  );
  assert(err.message.includes("gmail-client-id"));
  assert(err.message.includes("gmail-client-secret"));
  assert(err.message.includes("gmail-refresh-token"));
  assert(err.message.includes("swamp vault put-secret gmail"));
  assert(err.message.includes("swamp model create @mgreten/gmail-read"));
  assert(err.message.includes("gmail.readonly"));
});

Deno.test("requireAuth - throws naming only the missing credential(s)", () => {
  const err = assertThrows(
    () =>
      requireAuth({
        clientId: "client-123",
        clientSecret: "",
        refreshToken: "refresh-789",
      }),
    Error,
  );
  assert(err.message.includes("gmail-client-secret"));
  assert(!err.message.includes("gmail-client-id,"));
});

Deno.test("requireAuth - passes when all three creds are set", () => {
  const result = requireAuth(authedGlobalArgs());
  assertEquals(result, {
    clientId: "client-123",
    clientSecret: "secret-456",
    refreshToken: "refresh-789",
  });
});

Deno.test("buildTokenRefreshBody - well-formed refresh_token grant body", () => {
  const body = buildTokenRefreshBody("cid", "csecret", "rtoken");
  const params = new URLSearchParams(body);
  assertEquals(params.get("grant_type"), "refresh_token");
  assertEquals(params.get("client_id"), "cid");
  assertEquals(params.get("client_secret"), "csecret");
  assertEquals(params.get("refresh_token"), "rtoken");
});

Deno.test("refreshAccessToken - posts to the correct URL and parses access_token", async () => {
  let capturedUrl = "";
  let capturedInit: Parameters<FetchLike>[1] | undefined;
  const fetchImpl: FetchLike = (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return Promise.resolve(
      fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
    );
  };

  const token = await refreshAccessToken(
    fetchImpl,
    "cid",
    "csecret",
    "rtoken",
  );

  assertEquals(token, "at-abc123");
  assertEquals(capturedUrl, OAUTH_TOKEN_URL);
  assertEquals(capturedInit?.method, "POST");
  assertEquals(
    capturedInit?.headers?.["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const bodyParams = new URLSearchParams(capturedInit?.body ?? "");
  assertEquals(bodyParams.get("grant_type"), "refresh_token");
  assertEquals(bodyParams.get("client_id"), "cid");
  assertEquals(bodyParams.get("client_secret"), "csecret");
  assertEquals(bodyParams.get("refresh_token"), "rtoken");
});

Deno.test("refreshAccessToken - throws a descriptive error on a non-2xx response", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      fakeResponse(401, JSON.stringify({ error: "invalid_grant" })),
    );

  await assertRejects(
    () => refreshAccessToken(fetchImpl, "cid", "csecret", "bad-token"),
    Error,
    "401",
  );
});

Deno.test("refreshAccessToken - throws when the response has no access_token", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, JSON.stringify({ scope: "gmail" })));

  await assertRejects(
    () => refreshAccessToken(fetchImpl, "cid", "csecret", "rtoken"),
    Error,
    "no access_token",
  );
});

Deno.test("refreshAccessToken - throws a descriptive error on a non-JSON response", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, "this is not json"));

  await assertRejects(
    () => refreshAccessToken(fetchImpl, "cid", "csecret", "rtoken"),
    Error,
    "non-JSON",
  );
});

Deno.test("refreshAccessToken - redacts clientSecret and refreshToken from a non-2xx error body", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      fakeResponse(
        400,
        JSON.stringify({
          error: "invalid_request",
          error_description:
            "client_secret=super-secret-value refresh_token=super-refresh-value is invalid",
        }),
      ),
    );

  const err = await assertRejects(
    () =>
      refreshAccessToken(
        fetchImpl,
        "cid",
        "super-secret-value",
        "super-refresh-value",
      ),
    Error,
  );
  assert(!err.message.includes("super-secret-value"));
  assert(!err.message.includes("super-refresh-value"));
  assert(err.message.includes("[redacted]"));
});

Deno.test("listMessageIds - calls messages.list with the right q + maxResults, extracts ids", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> | undefined;
  const fetchImpl: FetchLike = (url, init) => {
    capturedUrl = url;
    capturedHeaders = init?.headers;
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
      ),
    );
  };

  const result = await listMessageIds(
    fetchImpl,
    "at-abc123",
    "is:unread newer_than:1d",
    50,
  );

  assertEquals(result.ids, ["m1", "m2"]);
  assertEquals(result.truncated, false);
  assert(capturedUrl.startsWith(`${GMAIL_API_BASE}/messages?`));
  assert(
    capturedUrl.includes(
      `q=${encodeURIComponent("is:unread newer_than:1d")}`,
    ),
  );
  assert(capturedUrl.includes("maxResults=50"));
  assertEquals(capturedHeaders?.["Authorization"], "Bearer at-abc123");
});

Deno.test("listMessageIds - empty inbox (no messages array) returns { ids: [], truncated: false }", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, JSON.stringify({})));

  const result = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 50);
  assertEquals(result.ids, []);
  assertEquals(result.truncated, false);
});

Deno.test("listMessageIds - non-2xx response throws a descriptive error", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(403, JSON.stringify({ error: "forbidden" })));

  await assertRejects(
    () => listMessageIds(fetchImpl, "at-abc123", "is:unread", 50),
    Error,
    "403",
  );
});

Deno.test("listMessageIds - non-JSON response throws a descriptive error", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, "<html>not json</html>"));

  await assertRejects(
    () => listMessageIds(fetchImpl, "at-abc123", "is:unread", 50),
    Error,
    "non-JSON",
  );
});

Deno.test("listMessageIds - malformed 'messages' (not an array) throws a structured error, not a raw TypeError", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      fakeResponse(200, JSON.stringify({ messages: "not-an-array" })),
    );

  await assertRejects(
    () => listMessageIds(fetchImpl, "at-abc123", "is:unread", 50),
    Error,
    "malformed response",
  );
});

Deno.test("listMessageIds - follows nextPageToken to accumulate ids across pages", async () => {
  const seenPageTokens: Array<string | null> = [];
  const fetchImpl: FetchLike = (url) => {
    const u = new URL(url);
    const pageToken = u.searchParams.get("pageToken");
    seenPageTokens.push(pageToken);
    if (!pageToken) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            messages: [{ id: "m1" }, { id: "m2" }],
            nextPageToken: "page-2",
          }),
        ),
      );
    }
    return Promise.resolve(
      fakeResponse(200, JSON.stringify({ messages: [{ id: "m3" }] })),
    );
  };

  const result = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 10);

  assertEquals(result.ids, ["m1", "m2", "m3"]);
  assertEquals(result.truncated, false);
  assertEquals(seenPageTokens, [null, "page-2"]);
});

Deno.test("listMessageIds - stops at maxResults and sets truncated:true when more pages remain", async () => {
  const fetchImpl: FetchLike = (url) => {
    const u = new URL(url);
    const pageToken = u.searchParams.get("pageToken");
    if (!pageToken) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            messages: [{ id: "m1" }, { id: "m2" }],
            nextPageToken: "page-2",
          }),
        ),
      );
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          messages: [{ id: "m3" }, { id: "m4" }],
          nextPageToken: "page-3",
        }),
      ),
    );
  };

  const result = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 3);

  assertEquals(result.ids, ["m1", "m2", "m3"]);
  assertEquals(result.truncated, true);
});

Deno.test("listMessageIds - exactly maxResults matches with no nextPageToken is NOT truncated", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
      ),
    );

  const result = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 2);

  assertEquals(result.ids, ["m1", "m2"]);
  assertEquals(result.truncated, false);
});

Deno.test("parseMessageMetadata - maps From/Subject/Date/snippet into an item", () => {
  const item = parseMessageMetadata("m1", {
    snippet: "hey, quick question about...",
    payload: {
      headers: [
        { name: "Subject", value: "Quick question" },
        { name: "From", value: "Jane Doe <jane@example.com>" },
        { name: "Date", value: "Mon, 20 Jul 2026 10:00:00 -0600" },
      ],
    },
  });

  assertEquals(item, {
    id: "m1",
    from: "Jane Doe <jane@example.com>",
    subject: "Quick question",
    date: "Mon, 20 Jul 2026 10:00:00 -0600",
    snippet: "hey, quick question about...",
  });
});

Deno.test("parseMessageMetadata - header lookup is case-insensitive and tolerates missing headers", () => {
  const item = parseMessageMetadata("m2", {
    snippet: "",
    payload: {
      headers: [{ name: "subject", value: "lowercase header name" }],
    },
  });
  assertEquals(item.subject, "lowercase header name");
  assertEquals(item.from, "");
  assertEquals(item.date, "");
});

Deno.test("getMessageMetadata - calls messages.get with format=metadata for the id", async () => {
  let capturedUrl = "";
  const fetchImpl: FetchLike = (url) => {
    capturedUrl = url;
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "snip",
          payload: {
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "Subject", value: "Hi" },
              { name: "Date", value: "today" },
            ],
          },
        }),
      ),
    );
  };

  const item = await getMessageMetadata(fetchImpl, "at-abc123", "m42");

  assertEquals(item, {
    id: "m42",
    from: "a@b.com",
    subject: "Hi",
    date: "today",
    snippet: "snip",
  });
  assert(capturedUrl.startsWith(`${GMAIL_API_BASE}/messages/m42?`));
  assert(capturedUrl.includes("format=metadata"));
  assert(capturedUrl.includes("metadataHeaders=From"));
  assert(capturedUrl.includes("metadataHeaders=Subject"));
  assert(capturedUrl.includes("metadataHeaders=Date"));
});

Deno.test("getMessageMetadata - non-JSON response throws a descriptive error", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, "not json at all"));

  await assertRejects(
    () => getMessageMetadata(fetchImpl, "at-abc123", "m1"),
    Error,
    "non-JSON",
  );
});

Deno.test("getMessageMetadata - non-2xx response redacts the access token from the thrown error", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(401, "token at-secret-xyz is invalid"));

  const err = await assertRejects(
    () => getMessageMetadata(fetchImpl, "at-secret-xyz", "m1"),
    Error,
  );
  assert(!err.message.includes("at-secret-xyz"));
  assert(err.message.includes("[redacted]"));
});

Deno.test("parseMessageMetadata - malformed 'payload.headers' (not an array) throws a structured error, not a raw TypeError", () => {
  assertThrows(
    () =>
      parseMessageMetadata("m1", {
        snippet: "hi",
        // deno-lint-ignore no-explicit-any
        payload: { headers: "not-an-array" as any },
      }),
    Error,
    "malformed",
  );
});

Deno.test("parseMessageMetadata - non-object header entries are ignored rather than throwing", () => {
  const item = parseMessageMetadata("m1", {
    snippet: "hi",
    payload: {
      // deno-lint-ignore no-explicit-any
      headers: ["not-an-object" as any, { name: "Subject", value: "ok" }],
    },
  });
  assertEquals(item.subject, "ok");
});

Deno.test("getAllMessageMetadata - a messages.get failure for one id skips it without crashing the run", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url.includes("/messages/bad-id")) {
      return Promise.resolve(fakeResponse(500, "internal error"));
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "ok",
          payload: { headers: [{ name: "Subject", value: "fine" }] },
        }),
      ),
    );
  };

  const skipped: string[] = [];
  const result = await getAllMessageMetadata(
    fetchImpl,
    "at-abc123",
    ["good-1", "bad-id", "good-2"],
    (id) => skipped.push(id),
  );

  assertEquals(result.items.map((i) => i.id), ["good-1", "good-2"]);
  assertEquals(result.errorCount, 1);
  assertEquals(skipped, ["bad-id"]);
});

Deno.test("getAllMessageMetadata - every id failing reports errorCount === attempted count", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(500, "internal error"));

  const skipped: string[] = [];
  const result = await getAllMessageMetadata(
    fetchImpl,
    "at-abc123",
    ["bad-1", "bad-2", "bad-3"],
    (id) => skipped.push(id),
  );

  assertEquals(result.items, []);
  assertEquals(result.errorCount, 3);
  assertEquals(skipped, ["bad-1", "bad-2", "bad-3"]);
});

Deno.test("runListUnread - full flow: token refresh -> list -> per-id metadata -> items", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ messages: [{ id: "m1" }] })),
      );
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "hello there",
          payload: {
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "Subject", value: "Test subject" },
              { name: "Date", value: "Mon, 20 Jul 2026 10:00:00 -0600" },
            ],
          },
        }),
      ),
    );
  };

  const result = await runListUnread(
    fetchImpl,
    authedGlobalArgs(),
    {},
    undefined,
    Date.parse("2026-07-20T16:00:00Z"),
  );

  assertEquals(result.ok, true);
  assertEquals(result.query, "is:unread newer_than:1d");
  assertEquals(result.maxResults, 50);
  assertEquals(result.count, 1);
  assertEquals(result.items, [
    {
      id: "m1",
      from: "sender@example.com",
      subject: "Test subject",
      date: "Mon, 20 Jul 2026 10:00:00 -0600",
      snippet: "hello there",
    },
  ]);
  assertEquals(calls[0], OAUTH_TOKEN_URL);
});

Deno.test("runListUnread - args.query/args.maxResults override the global defaults", async () => {
  let listUrl = "";
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      listUrl = url;
      return Promise.resolve(fakeResponse(200, JSON.stringify({})));
    }
    return Promise.resolve(fakeResponse(200, "{}"));
  };

  const result = await runListUnread(
    fetchImpl,
    authedGlobalArgs(),
    { query: "from:boss@example.com", maxResults: 5 },
  );

  assertEquals(result.query, "from:boss@example.com");
  assertEquals(result.maxResults, 5);
  assert(
    listUrl.includes(encodeURIComponent("from:boss@example.com")),
  );
  assert(listUrl.includes("maxResults=5"));
});

Deno.test("runListUnread - empty inbox (no messages array) -> count 0, items [], ok:true, no partial failure", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    // messages.list with no matches: Gmail omits `messages` entirely.
    return Promise.resolve(fakeResponse(200, JSON.stringify({})));
  };

  const result = await runListUnread(fetchImpl, authedGlobalArgs(), {});

  assertEquals(result.ok, true);
  assertEquals(result.count, 0);
  assertEquals(result.items, []);
  assertEquals(result.errorCount, 0);
  assertEquals(result.partialFailure, false);
  assertEquals(result.truncated, false);
});

Deno.test("runListUnread - throws (via requireAuth) before any fetch when creds are blank", async () => {
  let fetchCalled = false;
  const fetchImpl: FetchLike = () => {
    fetchCalled = true;
    return Promise.resolve(fakeResponse(200, "{}"));
  };

  await assertRejects(
    () =>
      runListUnread(
        fetchImpl,
        authedGlobalArgs({ refreshToken: "" }),
        {},
      ),
    Error,
    "gmail-refresh-token",
  );
  assertEquals(fetchCalled, false);
});

Deno.test("runListUnread - all messages.get calls failing -> ok:false, partialFailure:true, distinguishable from an empty inbox", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
        ),
      );
    }
    // Every messages.get call fails (simulated outage).
    return Promise.resolve(fakeResponse(500, "internal error"));
  };

  const warnings: string[] = [];
  const result = await runListUnread(
    fetchImpl,
    authedGlobalArgs(),
    {},
    undefined,
    undefined,
    (msg) => warnings.push(msg),
  );

  assertEquals(result.ok, false);
  assertEquals(result.count, 0);
  assertEquals(result.items, []);
  assertEquals(result.errorCount, 2);
  assertEquals(result.partialFailure, true);
  assert(warnings.some((w) => w.includes("every messages.get call failed")));
});

Deno.test("runListUnread - some messages.get calls failing -> ok:true, partialFailure:true", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({ messages: [{ id: "good" }, { id: "bad" }] }),
        ),
      );
    }
    if (url.includes("/messages/bad")) {
      return Promise.resolve(fakeResponse(500, "internal error"));
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "ok",
          payload: { headers: [{ name: "Subject", value: "fine" }] },
        }),
      ),
    );
  };

  const result = await runListUnread(fetchImpl, authedGlobalArgs(), {});

  assertEquals(result.ok, true);
  assertEquals(result.count, 1);
  assertEquals(result.errorCount, 1);
  assertEquals(result.partialFailure, true);
});

Deno.test("runListUnread - pagination truncation sets truncated:true and logs a warning", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      const u = new URL(url);
      if (!u.searchParams.get("pageToken")) {
        return Promise.resolve(
          fakeResponse(
            200,
            JSON.stringify({
              messages: [{ id: "m1" }],
              nextPageToken: "page-2",
            }),
          ),
        );
      }
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ messages: [{ id: "m2" }] })),
      );
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "ok",
          payload: { headers: [{ name: "Subject", value: "fine" }] },
        }),
      ),
    );
  };

  const warnings: string[] = [];
  const result = await runListUnread(
    fetchImpl,
    authedGlobalArgs({ maxResults: 1 }),
    {},
    undefined,
    undefined,
    (msg) => warnings.push(msg),
  );

  assertEquals(result.count, 1);
  assertEquals(result.truncated, true);
  assert(warnings.some((w) => w.includes("pagination truncated")));
});

Deno.test("GlobalArgsSchema - maxResults rejects a value above the 500 ceiling", () => {
  assertThrows(() =>
    GlobalArgsSchema.parse({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      maxResults: 501,
    })
  );
});

Deno.test("GlobalArgsSchema - maxResults rejects non-positive/non-integer values", () => {
  assertThrows(() =>
    GlobalArgsSchema.parse({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      maxResults: 0,
    })
  );
  assertThrows(() =>
    GlobalArgsSchema.parse({
      clientId: "c",
      clientSecret: "s",
      refreshToken: "r",
      maxResults: 1.5,
    })
  );
});

Deno.test("GlobalArgsSchema - maxResults accepts the default and in-bounds values", () => {
  const parsed = GlobalArgsSchema.parse({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
  });
  assertEquals(parsed.maxResults, 50);

  const parsedMax = GlobalArgsSchema.parse({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    maxResults: 500,
  });
  assertEquals(parsedMax.maxResults, 500);
});

Deno.test("redactSecrets - replaces every occurrence of each known secret with [redacted]", () => {
  const text = "client_secret=abc123 and again abc123, refresh_token=xyz789";
  const result = redactSecrets(text, ["abc123", "xyz789"]);
  assertEquals(
    result,
    "client_secret=[redacted] and again [redacted], refresh_token=[redacted]",
  );
});

Deno.test("redactSecrets - ignores blank/undefined secrets rather than corrupting the string", () => {
  const text = "hello world";
  assertEquals(redactSecrets(text, ["", undefined]), "hello world");
});

Deno.test("redactSecrets - no-op when none of the secrets appear in the text", () => {
  const text = "nothing sensitive here";
  assertEquals(redactSecrets(text, ["not-present"]), text);
});

// --- Regression: pagination dedup + repeated-token termination ---

Deno.test("listMessageIds - dedups ids that appear on more than one page", async () => {
  const fetchImpl: FetchLike = (url) => {
    const u = new URL(url);
    const pageToken = u.searchParams.get("pageToken");
    if (!pageToken) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            messages: [{ id: "m1" }, { id: "m2" }],
            nextPageToken: "page-2",
          }),
        ),
      );
    }
    // Page 2 overlaps with page 1 (m2 repeated) before giving a new id.
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({ messages: [{ id: "m2" }, { id: "m3" }] }),
      ),
    );
  };

  const result = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 10);

  assertEquals(result.ids, ["m1", "m2", "m3"]);
});

Deno.test("listMessageIds - breaks immediately (with a warning) when nextPageToken repeats, instead of looping to the page budget", async () => {
  let callCount = 0;
  const fetchImpl: FetchLike = () => {
    callCount++;
    // Every response points back to the same stuck token, forever.
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          messages: [{ id: `m${callCount}` }],
          nextPageToken: "stuck-token",
        }),
      ),
    );
  };

  const warnings: Array<{ msg: string; props?: Record<string, unknown> }> = [];
  const result = await listMessageIds(
    fetchImpl,
    "at-abc123",
    "is:unread",
    1000,
    (msg, props) => warnings.push({ msg, props }),
  );

  // First call has no pageToken; second call uses "stuck-token"; the third
  // would repeat it, so pagination should stop there instead of running to
  // MAX_LIST_PAGES (20).
  assertEquals(callCount, 2);
  assertEquals(result.ids, ["m1", "m2"]);
  assert(warnings.some((w) => w.msg.includes("repeated nextPageToken")));
});

Deno.test("runListUnread - dedup + repeated-token break surface through the full flow", async () => {
  let listCalls = 0;
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      listCalls++;
      // Always returns the same page + the same nextPageToken.
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            messages: [{ id: "dup-1" }],
            nextPageToken: "same-token",
          }),
        ),
      );
    }
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          snippet: "ok",
          payload: { headers: [{ name: "Subject", value: "fine" }] },
        }),
      ),
    );
  };

  const result = await runListUnread(fetchImpl, authedGlobalArgs(), {});

  // Only one unique id, and only 2 messages.list calls (first + one repeat
  // detection), never the full MAX_LIST_PAGES budget.
  assertEquals(result.items.map((i) => i.id), ["dup-1"]);
  assertEquals(listCalls, 2);
});

// --- Regression: redactSecrets URL-encoded form + redact-before-truncate ---

Deno.test("redactSecrets - also redacts the encodeURIComponent() form of a secret", () => {
  const secret = "s3cr3t value/with+special=chars";
  const encoded = encodeURIComponent(secret);
  const text = `error: token ${encoded} rejected`;
  const result = redactSecrets(text, [secret]);
  assertEquals(result, "error: token [redacted] rejected");
});

Deno.test("redactSecrets - empty-string secret is skipped and never corrupts the text", () => {
  const text = "some perfectly normal error text";
  // Unconfigured creds arrive as "" — must not turn into every character
  // (or every gap) being replaced with [redacted].
  assertEquals(redactSecrets(text, ["", "   ", undefined]), text);
});

Deno.test("refreshAccessToken - redacts a secret straddling the 500-char truncation boundary", async () => {
  const secret = "straddling-secret-value";
  // Grow the padding until the secret's occurrence straddles char 500
  // exactly (starts before it, ends after it) in the final JSON body — if
  // truncation ever ran before redaction again, this would leave a partial
  // (unmatched) fragment of the secret in the visible text.
  const buildBody = (padLen: number) =>
    JSON.stringify({
      error: "invalid_request",
      error_description: `${"x".repeat(padLen)}${secret}tail`,
    });
  let padLen = 400;
  let body = buildBody(padLen);
  while (
    !(body.indexOf(secret) < 500 && body.indexOf(secret) + secret.length > 500) &&
    padLen < 600
  ) {
    padLen++;
    body = buildBody(padLen);
  }
  const secretStart = body.indexOf(secret);
  assert(secretStart < 500);
  assert(secretStart + secret.length > 500);

  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(400, body));

  const err = await assertRejects(
    () => refreshAccessToken(fetchImpl, "cid", secret, "rtoken"),
    Error,
  );
  assert(!err.message.includes(secret));
  assert(!err.message.includes("straddling-secret-val")); // no partial leak
});

// --- Regression: crypto-random instance-name suffix ---

Deno.test("randomSuffix - returns a non-empty short string", () => {
  const suffix = randomSuffix();
  assert(suffix.length > 0);
  assert(suffix.length <= 6);
});

Deno.test("randomSuffix - two consecutive calls are (extremely likely to be) distinct", () => {
  const a = randomSuffix();
  const b = randomSuffix();
  // Not a strict crypto proof, but Math.random()-style collisions on a
  // 6-hex-char suffix would show up constantly across many draws; a single
  // crypto.randomUUID()-backed pair should essentially never collide.
  assert(a !== b);
});

Deno.test("randomSuffix - produces only lowercase hex characters (crypto.randomUUID-derived)", () => {
  for (let i = 0; i < 20; i++) {
    const suffix = randomSuffix();
    assert(/^[0-9a-f]+$/.test(suffix), `unexpected suffix format: ${suffix}`);
  }
});

// --- briefItems: generic { kind, title, body } summarizer shape ---

Deno.test("toBriefItem - maps a fully-populated MessageItem to kind/title/body", () => {
  const brief = toBriefItem({
    id: "m1",
    from: "Jane Doe <jane@example.com>",
    subject: "Quick question",
    date: "Mon, 20 Jul 2026 10:00:00 -0600",
    snippet: "hey, quick question about...",
  });

  assertEquals(brief, {
    kind: "email",
    title: "Quick question",
    body:
      "From Jane Doe <jane@example.com> (Mon, 20 Jul 2026 10:00:00 -0600): hey, quick question about...",
  });
});

Deno.test("toBriefItem - kind is always the literal 'email'", () => {
  const brief = toBriefItem({
    id: "m1",
    from: "a@b.com",
    subject: "s",
    date: "d",
    snippet: "sn",
  });
  assertEquals(brief.kind, "email");
});

Deno.test("toBriefItem - a message missing subject/from/date/snippet produces empty-string fields, not a crash", () => {
  const brief = toBriefItem({
    id: "m1",
    from: "",
    subject: "",
    date: "",
    snippet: "",
  });

  assertEquals(brief, {
    kind: "email",
    title: "",
    body: "From  (): ",
  });
});

Deno.test("toBriefItem - tolerates undefined/null fields on a maximally sparse item without throwing", () => {
  // deno-lint-ignore no-explicit-any
  const sparse = { id: "m1" } as any;
  const brief = toBriefItem(sparse);

  assertEquals(brief.kind, "email");
  assertEquals(brief.title, "");
  assertEquals(brief.body, "From  (): ");
});

Deno.test("toBriefItem - coerces non-string field values to strings rather than throwing", () => {
  // deno-lint-ignore no-explicit-any
  const weird = {
    id: "m1",
    from: 123 as any,
    subject: null as any,
    date: undefined as any,
    snippet: false as any,
  };
  const brief = toBriefItem(weird);

  assertEquals(brief.title, "");
  assertEquals(brief.body, "From 123 (): false");
});

Deno.test("runListUnread - briefItems has one entry per item, in kind/title/body shape", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    if (url.includes("/messages?")) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
        ),
      );
    }
    if (url.includes("/messages/m1")) {
      return Promise.resolve(
        fakeResponse(
          200,
          JSON.stringify({
            snippet: "hello there",
            payload: {
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "Subject", value: "Test subject" },
                { name: "Date", value: "Mon, 20 Jul 2026 10:00:00 -0600" },
              ],
            },
          }),
        ),
      );
    }
    // m2: no subject/snippet at all.
    return Promise.resolve(
      fakeResponse(
        200,
        JSON.stringify({
          payload: {
            headers: [{ name: "From", value: "other@example.com" }],
          },
        }),
      ),
    );
  };

  const result = await runListUnread(
    fetchImpl,
    authedGlobalArgs(),
    {},
    undefined,
    Date.parse("2026-07-20T16:00:00Z"),
  );

  assertEquals(result.count, 2);
  assertEquals(result.briefItems.length, result.items.length);
  assertEquals(result.briefItems, [
    {
      kind: "email",
      title: "Test subject",
      body:
        "From sender@example.com (Mon, 20 Jul 2026 10:00:00 -0600): hello there",
    },
    {
      kind: "email",
      title: "",
      body: "From other@example.com (): ",
    },
  ]);
  assert(result.briefItems.every((b) => b.kind === "email"));
});

Deno.test("runListUnread - empty inbox produces briefItems: [] alongside items: []", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve(
        fakeResponse(200, JSON.stringify({ access_token: "at-abc123" })),
      );
    }
    return Promise.resolve(fakeResponse(200, JSON.stringify({})));
  };

  const result = await runListUnread(fetchImpl, authedGlobalArgs(), {});

  assertEquals(result.items, []);
  assertEquals(result.briefItems, []);
  assertEquals(result.briefItems.length, result.items.length);
});
