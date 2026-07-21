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
 * can read `count` and `items`.
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
const GlobalArgsSchema: z.ZodObject<{
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
  if (!res.ok) {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh failed with ${res.status}: ${
        text.slice(0, 500)
      }`,
    );
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  if (!parsed.access_token) {
    throw new Error(
      `@mgreten/gmail-read: OAuth token refresh response had no access_token: ${
        text.slice(0, 500)
      }`,
    );
  }
  return parsed.access_token;
}

/** Bearer-auth header for an already-refreshed Gmail API access token. */
export function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** A raw Gmail `messages.list` response (subset used here). */
type MessagesListResponse = {
  messages?: Array<{ id?: string }>;
};

/**
 * List message ids matching `query`, bounded to `maxResults`. Returns `[]`
 * when the mailbox has no matches (Gmail omits the `messages` array entirely
 * in that case rather than returning an empty one).
 */
export async function listMessageIds(
  fetchImpl: FetchLike,
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<string[]> {
  const url = `${GMAIL_API_BASE}/messages?q=${
    encodeURIComponent(query)
  }&maxResults=${maxResults}`;
  const res = await fetchImpl(url, { headers: bearerHeaders(accessToken) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `@mgreten/gmail-read: messages.list failed with ${res.status}: ${
        text.slice(0, 500)
      }`,
    );
  }
  let parsed: MessagesListResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gmail-read: messages.list returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  const ids = parsed.messages ?? [];
  return ids
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** A parsed message metadata row: From / Subject / Date / snippet. */
export type MessageItem = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

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
  const headers = body.payload?.headers ?? [];
  const header = (name: string): string => {
    const found = headers.find(
      (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    return found?.value ?? "";
  };
  return {
    id,
    from: header("From"),
    subject: header("Subject"),
    date: header("Date"),
    snippet: body.snippet ?? "",
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
        text.slice(0, 500)
      }`,
    );
  }
  let parsed: MessageMetadataResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gmail-read: messages.get(${id}) returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  return parseMessageMetadata(id, parsed);
}

/**
 * Fetch metadata for every id in `ids`, skipping (with a logged warning
 * rather than crashing the whole run) any individual message whose
 * `messages.get` call fails — a single transient/deleted-message error
 * shouldn't blank out an otherwise-successful batch.
 */
export async function getAllMessageMetadata(
  fetchImpl: FetchLike,
  accessToken: string,
  ids: string[],
  onSkip?: (id: string, error: unknown) => void,
): Promise<MessageItem[]> {
  const items: MessageItem[] = [];
  for (const id of ids) {
    try {
      items.push(await getMessageMetadata(fetchImpl, accessToken, id));
    } catch (error) {
      onSkip?.(id, error);
    }
  }
  return items;
}

/** Result schema for `list_unread`. */
const ListUnreadResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  query: z.string(),
  maxResults: z.number().int(),
  count: z.number().int(),
  items: z.array(z.object({
    id: z.string(),
    from: z.string(),
    subject: z.string(),
    date: z.string(),
    snippet: z.string(),
  })),
}).passthrough();

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
 */
export async function runListUnread(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof ListUnreadArgs>,
  onSkip?: (id: string, error: unknown) => void,
  now: number = Date.now(),
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
  const ids = await listMessageIds(
    fetchImpl,
    accessToken,
    effectiveQuery,
    effectiveMaxResults,
  );
  const items = await getAllMessageMetadata(
    fetchImpl,
    accessToken,
    ids,
    onSkip,
  );

  return {
    ok: true,
    ts: new Date(now).toISOString(),
    query: effectiveQuery,
    maxResults: effectiveMaxResults,
    count: items.length,
    items,
  };
}

/**
 * The swamp model: a read-only Gmail reader with one method (`list_unread`)
 * that persists a typed `messages` resource per call.
 */
export const model = {
  type: "@mgreten/gmail-read",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    messages: {
      description:
        "One row per list_unread call: the effective query/maxResults, a " +
        "count, and the parsed message items (From/Subject/Date/snippet).",
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
        );
        context.logger.info("list_unread", {
          query: record.query,
          maxResults: record.maxResults,
          count: record.count,
        });
        const handle = await context.writeResource(
          "messages",
          `messages-${record.ts}`,
          record,
          { tags: { count: String(record.count) } },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
