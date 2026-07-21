# @mgreten/gmail-read

**Read-only Gmail reader — list recent/unread messages via the Gmail REST
API. No write methods by design.**

A read-only Gmail surface for [swamp](https://swamp.club). Agents and
workflows often need to know "what's new in my inbox" without any capability
to send, delete, label, or modify anything. This model provides one method,
`list_unread`, that refreshes an OAuth access token from a long-lived
`gmail.readonly` refresh token, runs a Gmail search query, and pulls
From/Subject/Date/snippet metadata for each matching message — persisting the
result as a typed swamp resource so downstream CEL / `data.latest()`
consumers can read `count` and `items` directly.

Nothing here can mutate a mailbox. The refresh token this model expects is
scoped to `https://www.googleapis.com/auth/gmail.readonly` only, and every
Gmail call uses `format=metadata` (never `format=full`) — message bodies are
never fetched or decoded.

## Installation

```sh
swamp extension pull @mgreten/gmail-read
```

Then create a model instance:

```sh
swamp model create gmail --type @mgreten/gmail-read
```

## Setup

### Google OAuth credentials (vault-wired)

`list_unread` needs three OAuth values:

- a **client id** and **client secret** from a Google Cloud OAuth client of
  type **Desktop app**, and
- a long-lived **refresh token** obtained via the standard OAuth installed-app
  flow, scoped to **only** `https://www.googleapis.com/auth/gmail.readonly`.

This model does **not** read a vault itself. The recommended pattern is to
store all three in a swamp vault and wire them into the instance's
`globalArguments` with a CEL `vault.get(...)` reference; swamp resolves the
CEL at instance-load time and passes the resolved strings in as globalArgs:

```sh
swamp vault create local_encryption gmail
swamp vault put-secret gmail gmail-client-id
swamp vault put-secret gmail gmail-client-secret
swamp vault put-secret gmail gmail-refresh-token
```

```yaml
# models/<collective>/gmail/<id>.yaml
type: "@mgreten/gmail-read"
name: gmail
globalArguments:
  clientId: "${{ vault.get(gmail, gmail-client-id) }}"
  clientSecret: "${{ vault.get(gmail, gmail-client-secret) }}"
  refreshToken: "${{ vault.get(gmail, gmail-refresh-token) }}"
  query: "is:unread newer_than:1d"
  maxResults: 50
```

If any of the three is missing/blank, `list_unread` fails fast with a clear
error naming the exact `swamp vault put-secret` commands and the
`swamp model create` wiring — never a cryptic Gmail 401/403.

## Usage

List unread messages from the last day (the default query):

```sh
swamp model method run gmail list_unread
```

Override the query and result cap for one call:

```sh
swamp model method run gmail list_unread \
  --input query='from:billing@example.com is:unread' --input maxResults=10
```

## Global Arguments

| Argument       | Type   | Default                     | Notes                                              |
| -------------- | ------ | ---------------------------- | --------------------------------------------------- |
| `clientId`     | string | `""`                         | Google OAuth client ID (Desktop app). Wire from a vault. |
| `clientSecret` | string | `""` (sensitive)             | Google OAuth client secret. Wire from a vault.       |
| `refreshToken` | string | `""` (sensitive)             | `gmail.readonly`-scoped refresh token. Wire from a vault. |
| `query`        | string | `"is:unread newer_than:1d"`  | Default Gmail search query.                          |
| `maxResults`   | number | `50`                         | Default max messages per call.                       |

## Method: list_unread

| Argument     | Type   | Default | Notes                                                        |
| ------------ | ------ | ------- | -------------------------------------------------------------- |
| `query`      | string | —       | Optional. Overrides the global default `query` for this call.  |
| `maxResults` | number | —       | Optional (max 500). Overrides the global default `maxResults`. |

Persists a `messages` resource shaped:

```json
{
  "ok": true,
  "ts": "2026-07-20T16:00:00.000Z",
  "query": "is:unread newer_than:1d",
  "maxResults": 50,
  "count": 2,
  "errorCount": 0,
  "partialFailure": false,
  "truncated": false,
  "items": [
    {
      "id": "18f2a...",
      "from": "Jane Doe <jane@example.com>",
      "subject": "Quick question",
      "date": "Mon, 20 Jul 2026 10:00:00 -0600",
      "snippet": "hey, quick question about..."
    }
  ]
}
```

If an individual message's metadata fetch fails (e.g. a transient error or a
message that was deleted between the search and the fetch), that message is
skipped with a logged warning rather than failing the whole call — a single
bad id never blanks out an otherwise-successful batch. `errorCount` counts
how many `messages.get` calls failed and `partialFailure` is `true` whenever
`errorCount > 0`, so a downstream CEL consumer can tell "some messages
skipped" apart from a fully clean run. If **every** attempted `messages.get`
call fails, `ok` flips to `false` — otherwise a total outage would look
identical to a genuinely empty inbox (`count: 0, items: []` either way).

`list_unread` follows Gmail's `messages.list` pagination (`nextPageToken`) to
accumulate ids up to the effective `maxResults`, rather than silently
returning only the first page. If more messages matched the query than
`maxResults` allowed, `truncated` is `true` (with a logged warning) so a
caller knows results were capped rather than exhaustive.

## How It Works

1. **Auth check** — `requireAuth()` validates `clientId` / `clientSecret` /
   `refreshToken` are all present up front, so a misconfigured instance fails
   with a readable, actionable error instead of a cryptic Gmail 401/403.
2. **Token refresh** — `POST https://oauth2.googleapis.com/token` with a
   `application/x-www-form-urlencoded` `grant_type=refresh_token` body,
   parsing `access_token` from the JSON response.
3. **Search** — `GET .../messages?q=<query>&maxResults=<n>` with a `Bearer`
   auth header, extracting message ids from the response (Gmail omits the
   `messages` array entirely, rather than returning an empty one, when there
   are no matches).
4. **Per-message metadata** — `GET .../messages/<id>?format=metadata` (with
   `metadataHeaders=From/Subject/Date`), extracting those three headers
   (case-insensitive name match) plus the top-level `snippet`.
5. Every call persists the effective query, cap, count, and items as a
   `messages` swamp resource.

This model talks to the Gmail REST API with plain `fetch` (via an injectable
`FetchLike` type, so tests can mock HTTP), not the `googleapis` npm package —
a single read-only endpoint doesn't need that library's surface area.

## Known limitations

These are accepted trade-offs for the intended low-volume use (a personal or
small-team inbox poll, not a bulk mail-processing pipeline). They are not
bugs — re-architecting for them is deliberately out of scope unless the usage
pattern changes:

- **`messages.get` calls run serially, with no concurrency limit.**
  `getAllMessageMetadata` fetches one message's metadata at a time in a
  simple loop rather than fanning requests out in parallel (bounded or
  otherwise). For the default `maxResults` (50) and Gmail's per-user rate
  limits, serial fetches are fast enough and simplest to reason about. A
  large `maxResults` (up to the 500 ceiling) will be noticeably slower than a
  parallelized fetch, but won't hang — each request still completes or fails
  on its own.
- **No per-request timeout.** Neither the OAuth token refresh nor any Gmail
  API call sets an explicit fetch timeout; a hung request relies on the
  underlying HTTP client's/runtime's own defaults. For interactive or
  scheduled low-volume polls this hasn't been an operational problem, but a
  caller wrapping this model in a tight polling loop should apply its own
  outer timeout if a hard bound is needed.
- **Inconsistent degrade-vs-abort behavior between `listMessageIds` and
  `getAllMessageMetadata`.** A single failing `messages.list` page call
  aborts the entire `list_unread` call (throws), while a single failing
  `messages.get` call for one message id is skipped with a warning and the
  batch continues (`errorCount`/`partialFailure`). This asymmetry is
  intentional-by-accident rather than a designed contract: `messages.list`
  failures are rare and usually indicate an auth/quota problem worth failing
  loudly on, while `messages.get` failures are more often a single
  transient/deleted-message hiccup that shouldn't blank an otherwise-good
  batch. If this inconsistency becomes a real footgun for a caller, revisit
  it then rather than unifying the two paths preemptively.

## License

MIT — see LICENSE for details.
