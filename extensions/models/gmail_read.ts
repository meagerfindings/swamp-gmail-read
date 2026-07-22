/**
 * @module @mgreten/gmail-read
 *
 * Read-only Gmail reader — list recent/unread messages via the Gmail REST API.
 *
 * A single method, `list_unread`, that refreshes an OAuth access token from a
 * long-lived `gmail.readonly` refresh token, runs a Gmail search query, and
 * pulls per-message metadata (From / Subject / Date / snippet) for each
 * matching message id. Every call persists its result as a swamp resource
 * (`messages`) with a zod schema so downstream CEL / `data.latest()` consumers
 * can read `count` and `items`. The resource also carries `briefItems`, a
 * generic pre-shaped `{ kind, title, body }` array derived from each message
 * — useful for any "summarize these" consumer (not brief-specific) that can't
 * reshape `items` itself because CEL-in-YAML can't express map literals.
 *
 * ## Auth
 *
 * Gmail's API needs three OAuth values: a Desktop-app OAuth **client id**,
 * its **client secret**, and a long-lived **refresh token** scoped to
 * `https://www.googleapis.com/auth/gmail.readonly`. Supply them via the
 * sensitive `clientSecret` / `refreshToken` globalArguments (and the
 * non-sensitive `clientId`) — the intended pattern is to wire all three from a
 * swamp VAULT using a CEL `${{ vault.get(<vault>, <key>) }}` reference on the
 * model instance. This model does NOT read the vault itself: swamp resolves
 * the CEL at instance-YAML load time and hands the resolved strings in via
 * globalArgs. When the secrets are missing/unresolved the args arrive
 * empty-string; `requireAuth()` catches that up front and throws a clear,
 * actionable error rather than letting the call reach Google and come back as
 * a cryptic 401/403.
 *
 * The refresh token must be scoped ONLY to `gmail.readonly` — this model has
 * no write methods, so a broader scope grants capability the code can't use
 * and shouldn't be trusted with.
 *
 * ## No googleapis dependency
 *
 * This model talks to the Gmail REST API with plain `fetch` (via the
 * injectable {@link FetchLike}), not the `googleapis` npm package — a single
 * read-only endpoint doesn't need that library's surface area, and a smaller
 * dependency footprint is easier to audit and bundle.
 */

import { z } from "npm:zod@4";

/**
 * Global arguments for the gmail-read model. `clientSecret` and
 * `refreshToken` are sensitive (wire from a vault); `clientId` is the OAuth
 * Desktop-app client id (not secret, but still vault-wired by convention so
 * nothing personal is hardcoded on an instance). `query` and `maxResults` are
 * the default Gmail search scope, overridable per `list_unread` call.
 */
export const GlobalArgsSchema: z.ZodObject<{
  clientId: z.ZodDefault<z.ZodString>;
  clientSecret: z.ZodDefault<z.ZodString>;
  refreshToken: z.ZodDefault<z.ZodString>;
  query: z.ZodDefault<z.ZodString>;
  maxResults: z.ZodDefault<z.ZodNumber>;
}> = z.object({
  clientId: z
    .string()
    .default("")
    .describe(
      "Google OAuth client ID (Desktop app type). Wire from a vault, e.g. " +
        "${{ vault.get(gmail, gmail-client-id) }}.",
    ),
  clientSecret: z
    .string()
    .default("")
    .describe(
      "Google OAuth client secret. Wire from a vault, e.g. " +
        "${{ vault.get(gmail, gmail-client-secret) }}.",
    )
    .meta({ sensitive: true }),
  refreshToken: z
    .string()
    .default("")
    .describe(
      "Long-lived OAuth refresh token scoped to " +
        "https://www.googleapis.com/auth/gmail.readonly. Wire from a vault, " +
        "e.g. ${{ vault.get(gmail, gmail-refresh-token) }}.",
    )
    .meta({ sensitive: true }),
  query: z
    .string()
    .default("is:unread newer_than:1d")
    .describe("Default Gmail search query (Gmail search syntax)."),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(50)
    .describe("Default max messages to return per call."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Method execution context (mirrors the shape swamp injects into `execute`). */
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
    options?: { tags?: Record<string, string> },
  ) => Promise<Record<string, unknown>>;
  modelType: string;
  modelId: string;
};

/** Minimal fetch signature the HTTP calls depend on (injectable in tests). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** The real `fetch`, adapted to the injectable {@link FetchLike} shape. */
const realFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

/**
 * Validate that all three OAuth credentials are present. Throws a clear,
 * actionable error (naming the vault + `swamp model create` wiring commands)
 * when any is missing/blank so a misconfigured instance fails fast instead of
 * returning a cryptic 401 from Google.
 */
export function requireAuth(
  g: Pick<GlobalArgs, "clientId" | "clientSecret" | "refreshToken">,
): { clientId: string; clientSecret: string; refreshToken: string } {
  const missing: string[] = [];
  if (!g.clientId || g.clientId.trim() === "") missing.push("gmail-client-id");
  if (!g.clientSecret || g.clientSecret.trim() === "") {
    missing.push("gmail-client-secret");
  }
  if (!g.refreshToken || g.refreshToken.trim() === "") {
    missing.push("gmail-refresh-token");
  }
  if (missing.length > 0) {
    const putSecrets = missing
      .map((key) => `  swamp vault put-secret gmail ${key}`)
      .join("\n");
    throw new Error(
      `@mgreten/gmail-read: missing Gmail OAuth credential(s): ${
        missing.join(", ")
      }. ` +
        `Add them to a vault:\n${putSecrets}\n` +
        `then wire them into the instance globalArguments, e.g.:\n` +
        `  swamp model create @mgreten/gmail-read gmail \\\n` +
        `    --global-arg 'clientId=\${{ vault.get(gmail, gmail-client-id) }}' \\\n` +
        `    --global-arg 'clientSecret=\${{ vault.get(gmail, gmail-client-secret) }}' \\\n` +
        `    --global-arg 'refreshToken=\${{ vault.get(gmail, gmail-refresh-token) }}'\n` +
        `The refresh token must be scoped to ` +
        `https://www.googleapis.com/auth/gmail.readonly only.`,
    );
  }
  return {
    clientId: g.clientId,
    clientSecret: g.clientSecret,
    refreshToken: g.refreshToken,
  };
}

/** Google's OAuth 2.0 token endpoint. */
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The Gmail API v1 base URL, scoped to the authenticated user (`me`). */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Build the `application/x-www-form-urlencoded` body for a refresh-token
 * grant against Google's OAuth token endpoint.
 */
export function buildTokenRefreshBody(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): string {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return params.toString();
}

/**
 * Exchange a refresh token for a short-lived access token via Google's OAuth
 * token endpoint. Throws a descriptive error (including the response body,
 * truncated) on a non-2xx response or a response missing `access_token`.
 */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const body = buildTokenRefreshBody(clientId, clientSecret, refreshToken);
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  const secrets = [clientSecret, refreshToken];
  if (!res.ok) {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh failed with ${res.status}: ${
        redactSecrets(text, secrets).slice(0, 500)
      }`,
    );
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh returned non-JSON: ${
        redactSecrets(text, secrets).slice(0, 200)
      }`,
    );
  }
  if (!parsed.access_token) {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh response had no access_token: ${
        redactSecrets(text, secrets).slice(0, 500)
      }`,
    );
  }
  return parsed.access_token;
}

/**
 * A short crypto-random suffix (6 hex chars). Originally used to disambiguate
 * per-call `writeResource` instance names created in the same `Date.now()`
 * millisecond tick under concurrency; the model now writes every `list_unread`
 * call to a single STABLE instance name (`"messages"`) so downstream
 * consumers can reference the newest snapshot deterministically via
 * `data.latest(...)` — swamp's own auto-versioning handles the
 * same-millisecond-write case, so this is no longer called from the model
 * body. Kept as an exported utility (harmless, still unit-tested) rather than
 * deleted, since removing a public export isn't required just because its one
 * internal caller went away. Uses `crypto.randomUUID()` rather than
 * `Math.random()` — `Math.random()` is not a cryptographically secure source
 * and its output is unsuitable wherever "guess the next value" matters, even
 * for a low-stakes uniqueness suffix; `crypto.randomUUID()` is available in
 * Deno/modern runtimes with no extra dependency and removes the debate
 * entirely.
 */
export function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6);
}

/** Bearer-auth header for an already-refreshed Gmail API access token. */
export function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Redact any occurrence of known secret values from a string before it's
 * embedded in a thrown error. Error bodies (OAuth/Gmail responses) are
 * attacker- or Google-controlled text that gets surfaced verbatim in error
 * messages that may end up in logs, swamp reports, or agent transcripts —
 * secrets in scope at the throw site (the client secret, refresh token, and
 * any already-obtained access token) must never leak through that path.
 * Blank/undefined secrets are skipped (redacting `""` would corrupt the
 * string by matching everywhere — this also covers unconfigured/empty
 * creds, which must never turn into "every character redacted").
 *
 * Also redacts the `encodeURIComponent()` form of each secret, so a secret
 * that shows up URL-encoded in an error body (e.g. echoed back inside a
 * query string) is still caught, not just the plain-text form. Callers MUST
 * redact BEFORE truncating a response body to a preview length — truncating
 * first can slice through the middle of a secret, leaving a fragment that no
 * longer matches either form and slips through unredacted.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      redacted = redacted.split(encoded).join("[redacted]");
    }
  }
  return redacted;
}

/** A raw Gmail `messages.list` response (subset used here). */
type MessagesListResponse = {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
};

/** The outcome of {@link listMessageIds}: the accumulated ids plus whether
 * more results existed beyond `maxResults` (Gmail returns `nextPageToken`
 * when a page isn't the last one). */
export type ListMessageIdsResult = {
  ids: string[];
  truncated: boolean;
};

/** Maximum Gmail `messages.list` pages {@link listMessageIds} will fetch
 * for a single call, regardless of `maxResults`. This is a hard ceiling on
 * network round-trips, independent of the result-count cap — it exists so a
 * pathological/adversarial response (e.g. an endless stream of
 * `nextPageToken`s with tiny pages) can't turn one call into an unbounded
 * loop. `maxResults` is capped at 500 and Gmail pages are up to 500 ids, so
 * in practice one or two pages satisfy any real call. */
const MAX_LIST_PAGES = 20;

/**
 * List message ids matching `query`, bounded to `maxResults`, following
 * Gmail's `nextPageToken` pagination as needed to reach that cap. Returns
 * `{ ids: [], truncated: false }` when the mailbox has no matches (Gmail
 * omits the `messages` array entirely in that case rather than returning an
 * empty one). If more results existed beyond `maxResults` when the cap was
 * reached, `truncated` is `true` so a caller can distinguish "there were
 * exactly N matches" from "there were more than N and we stopped at N".
 *
 * Ids are deduped across pages (a `Set` tracks ids already accumulated), and
 * page tokens are tracked too: if a `nextPageToken` repeats a token already
 * seen (a buggy or adversarial response stuck on one page), pagination
 * breaks immediately with a logged warning rather than looping to
 * {@link MAX_LIST_PAGES} on a page that will never advance.
 */
export async function listMessageIds(
  fetchImpl: FetchLike,
  accessToken: string,
  query: string,
  maxResults: number,
  onWarning?: (msg: string, props?: Record<string, unknown>) => void,
): Promise<ListMessageIdsResult> {
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        // A repeated nextPageToken means the response is stuck (buggy or
        // adversarial) rather than genuinely paginating — break instead of
        // burning the rest of the MAX_LIST_PAGES budget on a page we've
        // already fetched.
        onWarning?.(
          "listMessageIds: repeated nextPageToken; stopping pagination " +
            "instead of looping to the page budget",
          { pageToken },
        );
        break;
      }
      seenPageTokens.add(pageToken);
    }
    const url =
      `${GMAIL_API_BASE}/messages?q=${
        encodeURIComponent(query)
      }&maxResults=${maxResults}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fetchImpl(url, { headers: bearerHeaders(accessToken) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `@mgreten/gmail-read: messages.list failed with ${res.status}: ${
          redactSecrets(text, [accessToken]).slice(0, 500)
        }`,
      );
    }
    let parsed: MessagesListResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `@mgreten/gmail-read: messages.list returned non-JSON: ${
          redactSecrets(text, [accessToken]).slice(0, 200)
        }`,
      );
    }
    const rawMessages = parsed.messages;
    if (rawMessages !== undefined && !Array.isArray(rawMessages)) {
      throw new Error(
        `@mgreten/gmail-read: messages.list returned a malformed response ` +
          `(expected "messages" to be an array): ${
            redactSecrets(text, [accessToken]).slice(0, 200)
          }`,
      );
    }
    const pageIds = (rawMessages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    for (const id of pageIds) {
      if (ids.length >= maxResults) {
        truncated = true;
        break;
      }
      // Dedup across pages: a page overlap (e.g. a page boundary shifting
      // under concurrent mailbox activity) must not double-count or
      // double-fetch metadata for the same message id.
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
    }

    if (ids.length >= maxResults) {
      // Reached the cap. If Gmail still had more to give, flag truncation
      // even if this exact page happened to end exactly at the cap.
      truncated = truncated || typeof parsed.nextPageToken === "string";
      break;
    }
    if (!parsed.nextPageToken) {
      break;
    }
    pageToken = parsed.nextPageToken;
  }

  return { ids, truncated };
}

/** A parsed message metadata row: From / Subject / Date / snippet. */
export type MessageItem = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

/**
 * A generic `{ kind, title, body }` shape derived from a {@link MessageItem},
 * meant for any "summarize these" downstream consumer (a daily-brief
 * pipeline, a digest, an LLM summarizer) rather than being brief-specific.
 * `kind` is always the literal `"email"` so a consumer merging items across
 * multiple source models (calendar, Slack, etc.) can discriminate by source.
 */
export type BriefItem = {
  kind: "email";
  title: string;
  body: string;
};

/** Coerce a possibly-missing field to a string, defaulting to `""` rather
 * than `undefined`/`null` — {@link toBriefItem} must never throw or produce
 * an `undefined` field, even from a maximally sparse message. */
function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Derive a generic {@link BriefItem} from a {@link MessageItem}. `title` maps
 * from `subject` (empty string when absent); `body` is a one-line
 * `From <from> (<date>): <snippet>` summary. Every part is coerced to a
 * string and missing fields become `""`, so a maximally sparse message (no
 * subject/snippet/etc.) still produces a valid, never-throwing item.
 */
export function toBriefItem(item: MessageItem): BriefItem {
  const from = coerceToString(item?.from);
  const date = coerceToString(item?.date);
  const snippet = coerceToString(item?.snippet);
  const subject = coerceToString(item?.subject);
  return {
    kind: "email",
    title: subject,
    body: `From ${from} (${date}): ${snippet}`,
  };
}

/** A raw Gmail `messages.get?format=metadata` response (subset used here). */
type MessageMetadataResponse = {
  snippet?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
};

/**
 * Extract the `From`, `Subject`, and `Date` header values (case-insensitive
 * header name match) plus the top-level `snippet` from a Gmail
 * `messages.get?format=metadata` response body.
 */
export function parseMessageMetadata(
  id: string,
  body: MessageMetadataResponse,
): MessageItem {
  const rawHeaders = body.payload?.headers;
  if (rawHeaders !== undefined && !Array.isArray(rawHeaders)) {
    throw new Error(
      `@mgreten/gmail-read: messages.get(${id}) returned a malformed ` +
        `response (expected "payload.headers" to be an array)`,
    );
  }
  const headers = (rawHeaders ?? []).filter(
    (h): h is { name?: string; value?: string } =>
      typeof h === "object" && h !== null,
  );
  const header = (name: string): string => {
    const found = headers.find(
      (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    return typeof found?.value === "string" ? found.value : "";
  };
  return {
    id,
    from: header("From"),
    subject: header("Subject"),
    date: header("Date"),
    snippet: typeof body.snippet === "string" ? body.snippet : "",
  };
}

/**
 * Fetch metadata (From/Subject/Date headers + snippet, no body) for one
 * message id. Uses `format=metadata` — never `format=full` — since the
 * snippet already covers a preview and this model never decodes message
 * bodies.
 */
export async function getMessageMetadata(
  fetchImpl: FetchLike,
  accessToken: string,
  id: string,
): Promise<MessageItem> {
  const url = `${GMAIL_API_BASE}/messages/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetchImpl(url, { headers: bearerHeaders(accessToken) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `@mgreten/gmail-read: messages.get(${id}) failed with ${res.status}: ${
        redactSecrets(text, [accessToken]).slice(0, 500)
      }`,
    );
  }
  let parsed: MessageMetadataResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gmail-read: messages.get(${id}) returned non-JSON: ${
        redactSecrets(text, [accessToken]).slice(0, 200)
      }`,
    );
  }
  return parseMessageMetadata(id, parsed);
}

/** The outcome of {@link getAllMessageMetadata}: the successfully-parsed
 * items plus how many of `ids` failed. */
export type AllMessageMetadataResult = {
  items: MessageItem[];
  errorCount: number;
};

/**
 * Fetch metadata for every id in `ids`, skipping (with a logged warning
 * rather than crashing the whole run) any individual message whose
 * `messages.get` call fails — a single transient/deleted-message error
 * shouldn't blank out an otherwise-successful batch. `errorCount` lets the
 * caller distinguish "every fetch failed" (an outage) from "the mailbox is
 * genuinely empty" — both would otherwise produce an identical `items: []`.
 */
export async function getAllMessageMetadata(
  fetchImpl: FetchLike,
  accessToken: string,
  ids: string[],
  onSkip?: (id: string, error: unknown) => void,
): Promise<AllMessageMetadataResult> {
  const items: MessageItem[] = [];
  let errorCount = 0;
  for (const id of ids) {
    try {
      items.push(await getMessageMetadata(fetchImpl, accessToken, id));
    } catch (error) {
      errorCount++;
      onSkip?.(id, error);
    }
  }
  return { items, errorCount };
}

/**
 * Result schema for `list_unread`. The shape is fully known (it's built
 * entirely in {@link runListUnread} from named fields, not merged from raw
 * Gmail API responses) — `.passthrough()` was dropped so an extra or
 * malformed field is caught by validation instead of silently riding along
 * into the persisted resource.
 */
const ListUnreadResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  query: z.string(),
  maxResults: z.number().int(),
  count: z.number().int(),
  errorCount: z.number().int(),
  partialFailure: z.boolean(),
  truncated: z.boolean(),
  items: z.array(z.object({
    id: z.string(),
    from: z.string(),
    subject: z.string(),
    date: z.string(),
    snippet: z.string(),
  })),
  briefItems: z.array(z.object({
    kind: z.string(),
    title: z.string(),
    body: z.string(),
  })),
});

/** Argument schema for `list_unread`. */
const ListUnreadArgs = z.object({
  query: z.string().optional().describe(
    "Gmail search query. Overrides the global default query when set.",
  ),
  maxResults: z.number().int().positive().max(500).optional().describe(
    "Max messages to return. Overrides the global default maxResults when set.",
  ),
});

/**
 * Run the full `list_unread` flow: refresh an access token, search for
 * message ids matching the effective query, then pull metadata for each.
 * `now` is injectable for deterministic tests.
 *
 * The result's `ok` flips to `false` only when every attempted
 * `messages.get` call fails (a total outage) — that's the one case
 * genuinely indistinguishable from success without a signal, since a
 * `count: 0` result is otherwise ambiguous between "mailbox empty" and
 * "every fetch errored". A partial failure (some ids succeeded, some
 * didn't) keeps `ok: true` but sets `partialFailure: true` so a downstream
 * CEL consumer can still tell the run wasn't fully clean.
 */
export async function runListUnread(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof ListUnreadArgs>,
  onSkip?: (id: string, error: unknown) => void,
  now: number = Date.now(),
  onWarning?: (msg: string, props?: Record<string, unknown>) => void,
): Promise<z.infer<typeof ListUnreadResultSchema>> {
  const { clientId, clientSecret, refreshToken } = requireAuth(g);
  const effectiveQuery = args.query ?? g.query;
  const effectiveMaxResults = args.maxResults ?? g.maxResults;

  const accessToken = await refreshAccessToken(
    fetchImpl,
    clientId,
    clientSecret,
    refreshToken,
  );
  const { ids, truncated } = await listMessageIds(
    fetchImpl,
    accessToken,
    effectiveQuery,
    effectiveMaxResults,
    onWarning,
  );
  if (truncated) {
    onWarning?.(
      "list_unread: pagination truncated at maxResults; more messages " +
        "matched the query than were returned",
      { query: effectiveQuery, maxResults: effectiveMaxResults },
    );
  }
  const { items, errorCount } = await getAllMessageMetadata(
    fetchImpl,
    accessToken,
    ids,
    onSkip,
  );
  const partialFailure = errorCount > 0;
  const allFailed = ids.length > 0 && items.length === 0 && errorCount > 0;
  if (partialFailure) {
    onWarning?.(
      allFailed
        ? "list_unread: every messages.get call failed; treating as a " +
          "failed run rather than an empty inbox"
        : "list_unread: some messages.get calls failed; result is a " +
          "partial batch",
      { attempted: ids.length, errorCount },
    );
  }

  return {
    ok: !allFailed,
    ts: new Date(now).toISOString(),
    query: effectiveQuery,
    maxResults: effectiveMaxResults,
    count: items.length,
    errorCount,
    partialFailure,
    truncated,
    items,
    briefItems: items.map(toBriefItem),
  };
}

/**
 * The swamp model: a read-only Gmail reader with one method (`list_unread`)
 * that persists a typed `messages` resource per call.
 */
export const model = {
  type: "@mgreten/gmail-read",
  version: "2026.07.20.5",
  globalArguments: GlobalArgsSchema,
  resources: {
    messages: {
      description:
        "One row per list_unread call: the effective query/maxResults, a " +
        "count, errorCount/partialFailure/truncated status flags, the " +
        "parsed message items (From/Subject/Date/snippet), and a generic " +
        "briefItems array ({ kind, title, body }) for any summarizer " +
        "consumer.",
      schema: ListUnreadResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    list_unread: {
      description:
        "List recent/unread Gmail messages for the configured mailbox: " +
        "refreshes an OAuth access token, runs a Gmail search query (default " +
        "'is:unread newer_than:1d'), and pulls From/Subject/Date/snippet " +
        "metadata for each matching message. Read-only — no message is ever " +
        "modified, and no message body is decoded (format=metadata only).",
      arguments: ListUnreadArgs,
      execute: async (
        args: z.infer<typeof ListUnreadArgs>,
        context: MethodContext,
      ) => {
        const record = await runListUnread(
          realFetch,
          context.globalArgs,
          args,
          (id, error) => {
            context.logger.warning("messages.get skipped", {
              id,
              error: error instanceof Error ? error.message : String(error),
            });
          },
          undefined,
          (msg, props) => {
            context.logger.warning(msg, props);
          },
        );
        context.logger.info("list_unread", {
          query: record.query,
          maxResults: record.maxResults,
          count: record.count,
          errorCount: record.errorCount,
          partialFailure: record.partialFailure,
          truncated: record.truncated,
        });
        // Write to a STABLE data name ("messages") rather than a timestamped
        // one. swamp auto-versions each write under the same name, so history
        // is preserved (every run is a new version) AND downstream consumers
        // can reference the newest snapshot deterministically with
        // `data.latest("<instance>", "messages")` — a timestamped name is
        // unpredictable and can't be referenced from a workflow step input.
        // Versioning also subsumes the old same-millisecond collision guard:
        // concurrent writes become distinct versions, not a name clash.
        const handle = await context.writeResource(
          "messages",
          "messages",
          record,
          {
            tags: {
              count: String(record.count),
              partialFailure: String(record.partialFailure),
              truncated: String(record.truncated),
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
