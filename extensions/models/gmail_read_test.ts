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
  GMAIL_API_BASE,
  listMessageIds,
  OAUTH_TOKEN_URL,
  parseMessageMetadata,
  refreshAccessToken,
  requireAuth,
  runListUnread,
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

  const ids = await listMessageIds(
    fetchImpl,
    "at-abc123",
    "is:unread newer_than:1d",
    50,
  );

  assertEquals(ids, ["m1", "m2"]);
  assert(capturedUrl.startsWith(`${GMAIL_API_BASE}/messages?`));
  assert(
    capturedUrl.includes(
      `q=${encodeURIComponent("is:unread newer_than:1d")}`,
    ),
  );
  assert(capturedUrl.includes("maxResults=50"));
  assertEquals(capturedHeaders?.["Authorization"], "Bearer at-abc123");
});

Deno.test("listMessageIds - empty inbox (no messages array) returns []", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve(fakeResponse(200, JSON.stringify({})));

  const ids = await listMessageIds(fetchImpl, "at-abc123", "is:unread", 50);
  assertEquals(ids, []);
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
  const items = await getAllMessageMetadata(
    fetchImpl,
    "at-abc123",
    ["good-1", "bad-id", "good-2"],
    (id) => skipped.push(id),
  );

  assertEquals(items.map((i) => i.id), ["good-1", "good-2"]);
  assertEquals(skipped, ["bad-id"]);
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

Deno.test("runListUnread - empty inbox (no messages array) -> count 0, items []", async () => {
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

  assertEquals(result.count, 0);
  assertEquals(result.items, []);
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
