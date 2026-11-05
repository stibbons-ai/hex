# hex

Daniel's personal agentic assistant (see [GLOSSARY.md](GLOSSARY.md) and [docs/adr](docs/adr)).
This workspace is the skeleton: a Bun server tracer running Mastra behind a small oRPC API, and the
tooling every later slice builds on.

## Install

Requires Bun 1.4.2 (the `packageManager` pin).

```sh
bun install --frozen-lockfile
```

`bunfig.toml` installs exact versions only and refuses packages published less than three days
ago. Every external dependency version lives in the root `package.json` `catalog`; packages
depend on externals with `catalog:` and on each other with `workspace:*`, and no manifest may use
`overrides` or `resolutions` (ADR 0003). To add a dependency, add the catalog entry first, then
reference it with `catalog:`.

## Run

```sh
bun run start
```

The server binds to `127.0.0.1` only, on `HEX_PORT` (default `4111`; `0` picks a free port), and
answers only requests whose `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (on port
80 also `127.0.0.1` and `localhost` without the port; 403 otherwise, against DNS rebinding). It stores Mastra's state in a LibSQL file at
`<data dir>/mastra.db`. The data directory is `HEX_DATA_DIR`, default `.data` relative to the
working directory (git-ignored at the repository root); it is created on start. Run it from the
repository root.
SIGINT or SIGTERM stops it: hex stops taking chat messages and the channels disconnect first, then
requests in flight, open streams and chat replies included, get 5 seconds before they are closed
(the cut-off is logged), then Mastra shuts down. A second signal of the same kind kills it at
once.

```sh
curl http://127.0.0.1:4111/health        # {"status":"ok"}
curl -X POST http://127.0.0.1:4111/rpc/workflows/list # {"json":["intake"]}: the oRPC API
```

Everything except `GET`/`HEAD /health` is the oRPC API under `/rpc` (ADR 0004), defined in
`packages/server/src/contract.ts`: `health`, `workflows.list`, `workflows.start` (runs a workflow
and returns its status and result) and `workflows.runs` (the runs persisted in LibSQL). An unknown
workflow is a `NOT_FOUND` error, input the workflow rejects a `BAD_REQUEST`. Call it with the
typed client:

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@hex/server";

const hex = createORPCClient<ContractRouterClient<typeof contract>>(
  new RPCLink({ url: "http://127.0.0.1:4111/rpc" }),
);
await hex.workflows.list();
```

Mastra's own REST routes (`/api/...`) are not served, so `mastra dev`/Studio clients of those
routes don't work against this entrypoint.

## Intake (dev command)

```sh
bun run intake path/to/mail.eml
```

runs the Intake workflow once, in process, on one `.eml` Intake and prints what it did: the
Documents it filed (paths relative to the Outbox; a Document filed by its received date is
marked `(no usable Document date; filed by received date)`), that the Intake has no Documents, or
that it was already processed. It exits with code 1 and a message on a file it can't read or
that is no mail, an Intake without a Message-ID or without a usable received date, a config it
can't use, or a failed run. Run it from the repository root. The same workflow is registered
with the server as `intake` (`workflows.start` with an Intake as `inputData`); the server opens
the Intake ledger at startup and fails to start when it can't.

The workflow, in order:

1. **Ledger check**: an Intake whose Message-ID (trimmed, without `<>`) is in the ledger was
   processed before; the run ends there and files nothing.
2. **Document detection** (`packages/domain/src/document.ts`): a Document is a PDF (also
   `application/octet-stream` named `*.pdf`) or a raster image (JPEG, PNG, GIF, WebP, HEIC/HEIF,
   TIFF, BMP). Not Documents: any part the HTML body references by `cid:` (signature images,
   logos, whatever their Content-Disposition), images under 10 KiB of content
   (`MIN_IMAGE_DOCUMENT_BYTES`: tracking pixels, icons; a PDF is never dropped for size), SVG,
   and every other type (`.ics`, text, office files). An attached mail (`message/rfc822`) is
   one non-Document attachment, never unpacked: the Documents inside it are not filed. An
   unreferenced `inline` image or PDF counts, since Apple Mail sends scans that way.
3. **Document dates** (`packages/adapters/src/date-extractor.ts`): a model reads each
   Document's Document date from the Document itself, handed over natively through Mastra's
   model router (PDFs as `application/pdf` file parts, JPEG, PNG, GIF and WebP images as image
   file parts, each by the type its content shows; hex does no OCR or text extraction and the
   model never sees the file name). The
   Document date is the date it was issued (invoice date, Rechnungsdatum, Belegdatum, receipt
   date), never a due date, delivery or service period, order date or the date it was printed
   or sent. The model answers `{ year, month, day }` as structured output (an Effect Schema,
   decoded again in the step), all `null` when the Document shows no date. Only content hex
   recognises as a PDF (`%PDF` within its first 1026 bytes) or a JPEG, PNG, GIF87a/89a or WebP
   image (by its signature) is sent; anything else never is, for one of two reasons: content
   matching none of Mastra's signatures Mastra would replace by a placeholder text the model
   answers blind; HEIC, HEIF, TIFF and BMP images (or AVIF content declared as another image
   type) Mastra would send but OpenAI and Anthropic refuse, failing the run every time. A model
   call that fails (network, missing or wrong API key, rate limit, provider error, a provider
   refusing the file) fails the run before anything is filed or recorded, so running the Intake
   again retries it; transient errors (rate limit, overload, a dropped or refused connection)
   are retried twice first, at least 3 s apart (longer when the provider asks, up to 30 s). A
   Document the provider rejects every time (e.g. an encrypted or oversized PDF) keeps failing
   its Intake until it is handled by hand. The error names the Document, the model and the HTTP
   status, if any, and keeps at most 300 characters of the provider's message.
4. **Filing**: each Document goes to `<Outbox>/YYYY-MM/<Category>/` by its Document date when
   the model answered a real day (four-digit year, month 1–12, a day that exists). Otherwise (no
   date, a reply that yields no object matching the schema: no JSON, a mismatch, an empty reply,
   one cut off at the token limit or withheld by a content filter; 30 February, month 13, a
   two-digit year; a Document not sent) it falls back to the Intake's received date as a calendar date in
   `Europe/Berlin`, and the Filing records that. The received date is the date after the last
   `;` of the topmost `Received:` header, else the `Date:` header, each only in the form
   `[Day,] D Mon YYYY HH:MM[:SS] zone` (four-digit year, two-digit hours, comments such as
   `(CET)` ignored), a header year of 1000 or later, a valid time (a leap second `:60` is read
   as `:59`) and a day that exists. The zone is `±HHMM` (up to 23:59) or
   a name: `UT`, `GMT` and the US names have their offsets, any other name (`UTC`, `Z`, `CET`)
   counts as UTC, as RFC 5322 §4.3 says. The date must fall in the years 1000 to 9999 in
   `Europe/Berlin`. The file name is the
   sender's, made safe: only its last `/` or `\` segment; every control and format character
   (`\p{Cc}`, `\p{Cf}`: NUL, line breaks, bidi overrides, zero-width characters) removed;
   leading dots, surrounding whitespace and trailing `.partial` suffixes stripped; at most 200
   UTF-8 bytes, keeping the extension unless it is over 32 bytes. Nothing left gives
   `document-<n>.<ext>`, `<n>` being the 1-based position among all of the Intake's attachments.
   A name already taken becomes `name (1).pdf`, `name (2).pdf`, …; nothing is ever overwritten.
   Each file is written as `<name>.<id>.partial` in the target folder (hex-sync skips
   `*.partial`), flushed, then hard-linked into place, which fails instead of replacing a file
   that appeared meanwhile; the folder is then flushed and the `.partial` removed. Once linked,
   the Document is filed: a failed flush or a `.partial` that can't be removed only logs a
   warning. A failed write removes its `.partial` (logging a warning if it can't); a crash or
   kill mid-write can leave one behind.
5. **Ledger**: the Intake is recorded as processed with its Filings, also when it had no
   Documents.

| Setting                        | Meaning                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `HEX_DATA_DIR`                 | Data directory with `mastra.db`, as for the server                                                                  |
| `HEX_OUTBOX_DIR`               | The Outbox; default `<data dir>/outbox`                                                                             |
| `HEX_CONFIG` `intake.category` | Category to file under; only `"ER"`, the default without the file, `intake` or `category`                           |
| `HEX_CONFIG` `intake.model`    | Mastra model-router id (`provider/model`) that reads Document dates; default `openai/gpt-5.1-codex-mini`            |
| `OPENAI_API_KEY`               | API key for the default model; another provider takes its own variable (e.g. `ANTHROPIC_API_KEY`), never the config |

The config file is the one described under [Chat](#chat-slack-signal), so its `chat` section is
required:

```json
{
  "chat": { "model": "anthropic/claude-opus-5-5", "channels": {} },
  "intake": { "category": "ER", "model": "openai/gpt-5.1-codex-mini" }
}
```

hex doesn't check at startup that the model's API key is set: without it every Intake with a
Document hex sends to the model fails until it is.

Only OpenAI models are exercised (by the tests' fake OpenAI). The answer schema goes to the
provider as JSON Schema with `additionalProperties: true` and safe-integer bounds (±(2^53−1)); a provider
that insists on strict JSON Schema (e.g. some OpenAI-compatible ones) may reject it, which fails
every run until `intake.model` names another model.

The ledger is the table `hex_intake_ledger` in `mastra.db`, created on first use: one row per
Intake with `message_id` (the key), `processed_at`, `document_count` and `filings` (JSON, one
`{ "index": …, "path": …, "fellBack": … }` per Document: its position among the attachments,
0-based, where it landed, and `true` when it was filed by the received date: the model answered
no usable Document date, or hex never sent the Document to a model (see step 3)). Entries
recorded before #7 (when hex filed every Document by the received date) have no `fellBack` and
read back without it. The workflow's result (`IntakeResult`)
carries the same Filings, also for an Intake already processed. An Intake whose run failed
halfway is not recorded, so running it again files the Documents that already landed a second
time, as `name (1).pdf`.

## Chat (Slack, Signal)

hex answers direct messages, @-mentions, and Daniel's follow-ups in channel threads it was asked
in, in Slack through Mastra Channels in Slack's socket mode: the server opens an outbound
WebSocket to Slack, so nothing is exposed publicly and no webhook route is served. On Signal it
answers 1:1 messages only, through a signal-cli daemon Daniel runs himself (see [Signal](#signal)).
Only senders on a channel's allowlist get an answer. Anyone else's DM, @-mention or reply in such
a thread (and button click, should interactivity ever be enabled) is ignored (no reply, nothing
persisted; Chat SDK holds the message in its in-memory thread history only) and logged as one line
with platform and sender ID, never the text; other channel messages never
reach hex at all. Messages arriving while hex shuts down are dropped and logged the same way.
Earlier messages of a channel thread are not read into memory. Slash commands are not answered.
Every allowlisted conversation, on every channel, shares the memory resource `daniel` (working
memory on, scoped to the resource), with one memory thread per conversation: a DM, a thread
inside a DM, or a channel thread. A failed reply posts "Something went wrong; see the hex log."
and logs the detail. No typing indicator is shown: Slack's (`assistant.threads.setStatus`)
targets its assistant threads, not the DMs and channel threads hex answers in.

Tool calls, such as working-memory updates, are not posted to the conversation: a tool card would
show the call's arguments and result, the working memory's content, which a channel thread makes
public. Only a tool that needs approval would still post its card with approval buttons; no hex
tool needs one. The operator sees each finished call in the hex log as one `hex: tool call` line
with the tool's name and call ID, never its arguments or result: at info level when the tool ran
without error (`ok: true`; a skipped working-memory update counts as ran), at warn level when it
failed (`ok: false`, `error`: `invalid input` or `error`).
Info lines show at Mastra's default level, which `bun run start` keeps; under
`NODE_ENV=production` Mastra logs only warnings and up, so only failures show. Mastra's own
warning for invalid tool input quotes the arguments. The memory thread doesn't keep the
working-memory calls; their effect is the working memory of resource `daniel` in `mastra.db`.

Chat is configured by a JSON file named by `HEX_CONFIG`. Unset, the server runs without chat and
says so once at startup. A file that can't be read or decoded, an unknown channel, or a missing or
malformed secret fails startup with the file and the problem. So does a channel that fails to
start (Signal: signal-cli unreachable, or it lists its accounts, or on a `-a` daemon the
account's own contact entry, without the bot account), doesn't start within 30 seconds (Slack:
bot-token check and socket connect; Signal: signal-cli health check, version, bot account lookup
and event stream), or starts but can't work (Slack rejected the bot token); the server then
closes what it started and `bun run start` exits with code 1. A Slack start that only
finishes after the deadline is disconnected again if it was still checking the bot token; one
still connecting its socket stays open until the process exits. A Signal start cut off by the
deadline goes no further, and closes any event stream it opened late. A Signal start error names
`SIGNAL_ACCOUNT` where the adapter would name the bot account.

```json
{
  "chat": {
    "model": "anthropic/claude-opus-5-5",
    "providerOptions": { "anthropic": { "effort": "low" } },
    "channels": {
      "slack": { "options": { "mode": "socket" }, "allowlist": ["U0123ABCD"] },
      "signal": { "options": {}, "allowlist": ["01234567-89ab-4cde-8f01-23456789abcd"] }
    }
  }
}
```

- `model`: a Mastra model-router id, `provider/model`. Its API key comes from the provider's usual
  environment variable (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- `providerOptions` (optional): passed unchanged to every model call, keyed by provider, as the
  provider defines them; here Anthropic's `effort` (`low` to `max`), which trades depth for speed
  and cost. Omitted, the provider's defaults apply. They are not checked at startup: a wrong value
  fails every reply (the cause is in the log), and an unknown provider key is ignored.
- `channels`: keyed by platform: `slack` (only `"mode": "socket"`) and `signal` (no options; an
  empty object). An empty `channels` object runs without chat. Adding a platform means installing
  its chat adapter package and adding it to `adapterFactories` in `packages/server/src/config.ts`.
- `allowlist`: exact sender IDs; whitespace is rejected when the file loads, case must match. An
  empty list answers no one and is logged once at startup.

Secrets live only in the environment, never in the file:

| Variable          | Holds                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `HEX_CONFIG`      | Path of the config file                                            |
| `SLACK_APP_TOKEN` | App-level token (must start `xapp-`) with `connections:write`      |
| `SLACK_BOT_TOKEN` | Bot user OAuth token (must start `xoxb-`)                          |
| `SLACK_API_URL`   | Optional Slack Web API base URL; tests point it at a fake one      |
| `SIGNAL_ACCOUNT`  | The Signal bot account: its number (`+15555550100`) or ACI         |
| `SIGNAL_CLI_URL`  | Base URL of the signal-cli HTTP daemon (`http://…` or `https://…`) |

### Slack app for socket mode

1. At [api.slack.com/apps](https://api.slack.com/apps): **Create New App** → **From an app
   manifest**, pick the workspace, paste:

   ```yaml
   display_information:
     name: hex
   features:
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: hex
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - channels:history
         - chat:write
         - groups:history
         - im:history
         - im:read
         - mpim:history
         - users:read
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
         - message.mpim
     socket_mode_enabled: true
   ```

2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**, scope
   `connections:write`: that `xapp-…` token is `SLACK_APP_TOKEN`.
3. **Install App** → install to the workspace: the **Bot User OAuth Token** (`xoxb-…`) is
   `SLACK_BOT_TOKEN`.
4. Your Slack user ID for the allowlist: in Slack, open your profile → **⋮** → **Copy member ID**
   (`U…`).

Run it, then DM the app in Slack (App Home → **Messages**):

```sh
export SLACK_APP_TOKEN=xapp-… SLACK_BOT_TOKEN=xoxb-… ANTHROPIC_API_KEY=…
HEX_CONFIG=hex.json bun run start   # logs "Slack socket mode connected", then "hex listening on …"
```

### Signal

hex uses [`@stibbons/chat-adapter-signal`](https://www.npmjs.com/package/@stibbons/chat-adapter-signal)
over signal-cli's HTTP daemon (`signal-cli daemon --http`, version 0.14.9 or newer), the
transport the adapter recommends. Installing signal-cli and registering or linking the bot account
are signal-cli's job, not hex's: follow the adapter's
[Provisioning the Bot Account](https://github.com/stibbons-ai/chat-adapter-signal#provisioning-the-bot-account)
and [Security](https://github.com/stibbons-ai/chat-adapter-signal#security) sections. Start the
daemon with `-a <account>` once the account is provisioned, plus `--receive-mode on-connection`
(nothing is received before hex connects) and `--no-receive-stdout` (message texts stay out of the
daemon's log).

The daemon has no authentication: whoever reaches it reads the bot's messages and sends as the
bot. Safe setups: hex in a container on the same Docker network as signal-cli, with no port
published; or signal-cli installed natively and bound to loopback (`daemon --http
127.0.0.1:8080`), where it also accepts only a loopback `Host` header, against DNS rebinding:
signal-cli v0.14.9 builds the allowed hosts in
[`buildAllowedHosts`](https://github.com/AsamK/signal-cli/blob/v0.14.9/src/main/java/org/asamk/signal/http/HttpServerHandler.java#L317-L327),
[`isHostAllowed`](https://github.com/AsamK/signal-cli/blob/v0.14.9/src/main/java/org/asamk/signal/http/HttpServerHandler.java#L329-L381)
compares the `Host` header, and its callers answer 421 when it doesn't match
([L126-130](https://github.com/AsamK/signal-cli/blob/v0.14.9/src/main/java/org/asamk/signal/http/HttpServerHandler.java#L126-L130),
[L180-184](https://github.com/AsamK/signal-cli/blob/v0.14.9/src/main/java/org/asamk/signal/http/HttpServerHandler.java#L180-L184)).
Unsafe: publishing a signal-cli container's port, even on `127.0.0.1`: inside the container it is
bound to `0.0.0.0`, where signal-cli checks no `Host` header, so any web page you open could reach
it.

- `SIGNAL_ACCOUNT` and `SIGNAL_CLI_URL` are the adapter's own variable names; hex reads them from
  its environment and passes both to the adapter. The bot account never goes into the config
  file or the repository. `options` must be `{}`.
- Allowlist IDs are ACIs (the account's UUID, lowercase with dashes, as signal-cli prints it),
  never phone numbers: the adapter keys every sender by ACI (its `message.author.userId`), which
  stays the same when the number changes and is there also for senders who hide their number. Any
  other entry fails startup, naming its position. To find yours, DM the bot before you are on the
  allowlist: hex logs `hex: ignored message from a sender not on the allowlist` with
  `sender: <your ACI>`.
- 1:1 messages only: an @-mention of hex in a Group, even from an allowlisted sender, is ignored and
  logged as `hex: ignored message outside a direct message`; other Group messages never reach hex.
  A Group is one conversation with all its members, so an answer there, working memory included,
  would go to all of them. No typing indicator is shown (hex turns Mastra's typing status off on
  every channel). Messages the adapter doesn't support (stickers, view-once messages) are ignored
  and logged only at debug level.
- Messages sent in a row are answered one after another, on every channel: hex sets the Chat SDK's
  `queue` strategy (Mastra's default is `concurrent`). A message that arrives while hex is still
  answering the same conversation waits; once the run is done, consecutive waiting messages from
  one sender are answered together in one turn. At most 10 wait per conversation, anyone's
  counting (in a Slack channel thread, others' messages too); beyond that the oldest is dropped,
  and a message still waiting after 90 s is dropped too, both without an answer and without a line
  in hex's log. Under `concurrent`, a message joined the run in progress, but Mastra
  finished it in a run that a stop could cut off before it was saved, and two first messages of a
  new conversation could land in two memory threads.
- hex keeps the adapter's receive cursor in its database: the newest event that, with every
  earlier one, hex has finished handling (later finished ones are stored too, to be skipped). A
  restarted hex resumes the event stream there, so signal-cli replays the events whose handling
  hadn't finished: a reply cut off by the 5-second stop grace or a crash, and messages signal-cli
  took off Signal after hex was gone (it notices only at its next keep-alive, within about 15-30 s,
  longer when the host itself is gone). Messages sent while no event stream was connected stay at
  Signal and arrive once hex connects (with `--receive-mode on-connection`). Limits:
  - lost: everything signal-cli held for replay when signal-cli itself restarts, and anything
    older than its last 1000 events;
  - lost: a message waiting behind a reply in progress in the same conversation when hex stops or
    crashes: its handling counts as finished once it is queued, and the queue lives in memory;
  - lost: until hex has finished its first event and every one before it (on a new database, or
    the first start after this upgrade), there is no cursor, so a restart replays nothing;
  - lost, during shutdown ([#29](https://github.com/stibbons-ai/hex/issues/29)): a message
    arriving after hex began stopping is dropped and the cursor moves past it;
  - answered twice: a message whose reply went out just before a crash, before its handling
    finished and the cursor was written; and, during shutdown (#29), one whose last cursor write
    missed the store closing.
- If the event stream drops while hex runs, the adapter reconnects by itself, with backoff up to
  30 s and one warning per attempt, for as long as hex runs; `/health` stays `ok` meanwhile, as it
  does while Slack's socket reconnects.

Run it against a daemon on loopback:

```sh
export SIGNAL_ACCOUNT=+15555550100 SIGNAL_CLI_URL=http://127.0.0.1:8080 ANTHROPIC_API_KEY=…
HEX_CONFIG=hex.json bun run start   # "Chat instance initialized", then "hex listening on …"
```

## Check

```sh
bun run check         # everything below, in this order; CI runs it on Ubuntu and macOS
bun run format:check  # oxfmt (bun run format writes)
bun run lint          # oxlint --deny-warnings
bun run typecheck     # tsc --noEmit for the root, then tsc --noEmit -p packages/domain
bun run manifests     # ADR 0003 catalog policy, exact @mastra/* pins, telemetry opt-out in scripts
bun run licenses      # dependency licence policy
bun run test          # bun test
```

## Eval fixtures

The evals run against folders of `.eml` Intakes, each labelled by one `expected.json`: per
Intake, its Documents in MIME order with their Document dates (`null` when a Document carries
none). `@hex/eval-harness` exports their types plus `decodeExpectedSet` and
`loadExpectedSet(folder)`, which decode strictly: they reject malformed or impossible dates,
duplicate `file` or `fileName` entries and unknown (mistyped) keys, report every problem at once
(a duplicate `fileName` is checked per Intake, once that Intake decodes; a duplicate `file` only
once every Intake decodes), and `loadExpectedSet` names the file in its errors. How a label names
an attachment without a file name, and why two attachments of one name can't be labelled, is in
[Evals](#evals).

`packages/eval-harness/fixtures/synthetic/` is a committed, fully fictitious set, so the evals run
without anyone's real mail. `packages/eval-harness/src/synthetic/` generates it without
dependencies (PDF, PNG and MIME writers, a bitmap font for the scans) and byte for byte
reproducibly: no clock, randomness, locale or compression library is involved, and
`.gitattributes` keeps git from converting their line endings. Change the generator, then
regenerate; a test fails when the committed files drift from the generator's output.

```sh
bun run fixtures:generate             # rewrites packages/eval-harness/fixtures/synthetic/
bun run fixtures:generate new-set     # or a missing or empty folder, relative to your directory
```

Run it from the repo root or a folder below it outside the workspace packages. A relative folder
resolves against your directory (`INIT_CWD` under npm, `npm_config_local_prefix` under bun; an
`INIT_CWD` inherited from a parent npm process wins under `bun run`). Before touching anything it
checks the target and accepts exactly two kinds: a missing or empty folder, which it fills, and
the committed folder, which it replaces in place. There it overwrites `expected.json` (generated
output; git restores only its last committed state) and deletes an `.eml` only if it is a regular
file whose header block carries the generator's `Message-ID <synthetic-…@hex-fixtures.example>`;
any other entry makes it refuse. Every other target (a non-empty folder elsewhere, a file) is
refused with a message naming the folder and why, so real fixtures elsewhere are not overwritten.

| Intake                       | Covers                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `01-de-pdf-invoice`          | German text PDF, `02.11.2026` beside Leistungsdatum and Fälligkeitsdatum           |
| `02-en-pdf-invoice`          | English text PDF, `2 Nov 2026` beside a Service period and a Due date              |
| `03-de-iso-date`             | ISO dates, Rechnungsdatum beside Bestelldatum and Lieferdatum                      |
| `04-de-long-date`            | `2. September 2026`, printed after the Fälligkeitsdatum                            |
| `05-en-month-boundary`       | Mail `Date:` 1 Oct, Document date `September 30, 2026`                             |
| `06-de-scan-png`             | Scanned invoice as a PNG, no text layer                                            |
| `07-en-scan-pdf`             | Scanned invoice as an image-only PDF                                               |
| `08-de-inline-logo`          | HTML logo via `cid:`, `Content-Disposition: inline`, over 20 KB: not a Document    |
| `09-en-outlook-signature`    | Signature image via `cid:` but marked `attachment` (Outlook style): not a Document |
| `10-de-tracking-pixel`       | 1×1 tracking pixel: not a Document                                                 |
| `11-en-zero-documents-ics`   | Zero Documents: only a calendar invite (`.ics`)                                    |
| `12-de-zero-documents-plain` | Zero Documents: plain text without attachments that mentions dates                 |
| `13-de-multiple-documents`   | Three Documents (invoice, credit note, scanned receipt) plus a `.txt` note         |
| `14-de-undated-document`     | A Document without any date: `documentDate` is `null`                              |

Real fixtures (exported mail with its labels) live outside the repo; point the evals at their
folder with `HEX_EVAL_FIXTURES` (see [Evals](#evals)). The root `.gitignore` guards against
committing them by accident (`git add -f` still
can): it ignores every `.eml` (any letter case) and `expected.json` except the `.eml` files
(lower case; on case-insensitive file systems any case) and `expected.json` directly in the
synthetic folder, any `fixtures/real/` and
`fixtures/private/` folder, and eval results in any `eval-results/` folder.

## Evals

`bun run eval` measures hex's two model-relevant decisions on a labelled fixture folder:
Document detection (`detectDocuments`) and Document date extraction (the DateExtractor on the
configured model). Run it by hand, with a real API key: it makes at most one model call per
labelled Document (none for one not sent), plus the DateExtractor's retries of transient provider
errors (up to 2 per call). No CI job runs it against a real model (`bun run check` runs its test
against a loopback fake), and it refuses to run (exit 1, nothing written, no model call) when the
`CI` environment variable is set to a non-empty value.

```sh
OPENAI_API_KEY=… bun run eval                                   # the committed synthetic set
OPENAI_API_KEY=… HEX_EVAL_FIXTURES=~/hex-fixtures bun run eval  # your own folder
```

- `HEX_EVAL_FIXTURES`: the fixture folder (`expected.json` and its `.eml` Intakes); default
  `packages/eval-harness/fixtures/synthetic/`. Only read, never written.
- `HEX_EVAL_RESULTS`: where reports go; default `eval-results/` in the repo root (git-ignored).
  It must not lie inside the fixture folder.
- `HEX_CONFIG`: the path of hex's config file; the model is its `intake.model`, or
  `openai/gpt-5.1-codex-mini` when the variable is unset or the file names none. Its API key
  comes from the provider's usual variable (`OPENAI_API_KEY`, …).

Relative paths resolve against the directory you ran it from, as for `fixtures:generate`. A label
names an attachment by its original file name or, when it has none, by the name hex would file it
under: `document-<position>.<ext>`, its 1-based position among the mail's attachments and `.pdf`
unless it is an image type. `report.json` lists every attachment by the exact name a label must
use (`report.md` collapses whitespace in names). A label naming no attachment of its `.eml`, or
one of several attachments with that name (such an Intake can't be labelled), or an `.eml` that
can't be read, fails the run before any model call, naming the file and the label; so does a
results folder that can't be created or written to. A failed model call is recorded on its
Document and the run goes on; the command exits 1 after writing the reports.

What it measures, per attachment matched to the labels by its file name:

- **Detection precision**: detected attachments that are labelled Documents / detected
  attachments. **Recall**: labelled Documents detected / labelled Documents. A zero denominator
  is not applicable (`null` in JSON, `n/a` in Markdown).
- **Exact accuracy**: labelled Documents whose predicted Document date is the labelled day /
  labelled Documents. **Month accuracy**: the same for year and month. A Document labelled
  undated is right only when no date is predicted; a failed call is always wrong.

Extraction runs on every labelled Document, whatever detection decided, so detection errors don't
reach its figures, and as the Intake workflow runs it: a Document whose content
`documentMediaType` rejects is not sent (predicted no date, counted as not sent), and the answer
is decoded by `documentDateOf`, so no date or no real day is no date. The verdicts come from
deterministic Mastra scorers (`createScorer`, run through the scorer's `run`):
`document-detection`, `document-date-exact` and `document-date-month`. No model judges them: a
set of attachments and a calendar day have exact right answers.

Each run writes `report.json` and `report.md` into its own folder,
`<results>/<UTC start time>_<model>/`, e.g. `2026-11-05T15-26-39-000Z_openai-gpt-5.1-codex-mini/`
(`-2`, `-3`… if taken, never overwritten): the fixture
folder, model, start time and duration; detection precision and recall with true positive,
false positive and false negative counts; exact and month accuracy with counts (`11/13 (84.6 %)`)
and the counts of Documents not sent and failed; and per Intake the attachment names by detection
verdict and per labelled Document the expected and predicted date (none, not sent, or the error)
with both verdicts. `report.json` decodes with `Report`, exported by `@hex/eval-harness`; `runEval`
takes the DateExtractor as a Layer, so a test can script the model.

## Packages

| Package             | Holds                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hex/domain`       | Pure domain: imports only `effect` and its own files, depends only on `effect`; sender allowlist, Document detection, Filing path, file names   |
| `@hex/adapters`     | Effect Schema → Mastra helper (`toMastraSchema`, ADR 0002); LibSQL storage; `.eml` reader, Outbox, Intake ledger, DateExtractor (model router)  |
| `@hex/server`       | `Bun.serve` entrypoint: `/health`, the oRPC API (`contract`), chat channels, the Intake workflow and `bun run intake`                           |
| `@hex/eval-harness` | `expected.json` types, decoder and loader; synthetic fixture set and its generator; `bun run eval` (`runEval`, `Report`, deterministic scorers) |

The domain's source imports are allow-listed by `scripts/domain-imports.test.ts`, its dependency
list by `bun run manifests`, and an oxlint override (run by `bun run lint`, so also in CI) flags
infrastructure imports there too. `packages/domain/tsconfig.json` type-checks its source without
Bun or Node globals, so `Bun.*` or `process` there fails `bun run typecheck`.

Mastra does not validate step output, so every step decodes its own output with its Effect schema;
`packages/adapters/test/schema.test.ts` pins that contract against real workflow runs. Use
schemas whose encoded and decoded types match: Mastra re-validates the decoded input at each step,
so transforming schemas (such as `Schema.NumberFromString`) fail there.

## Telemetry and licences

Every script that runs code starts with `MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`
(`bun run manifests` enforces it), and CI sets both. `MASTRA_TELEMETRY_DISABLED` is read by
`@mastra/core`'s usage telemetry; `DO_NOT_TRACK` turns off Bun's telemetry and crash reports
(`bunfig.toml` also sets `telemetry = false`). When you run `bun` or Mastra directly instead of
through a script, set both yourself.

`bun run licenses` audits every installed package's manifest plus the lockfile. Only MIT,
Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0, Unlicense and BlueOak-1.0.0 pass;
copyleft (GPL, LGPL, AGPL, MPL, …), non-commercial and unknown licences fail unless
`scripts/license-allowlist.json` has an exact package, version and licence entry with a reviewed
reason. Packages for other platforms, which are never installed locally, are audited from
`scripts/platform-license-metadata.json` (licence, lockfile integrity and npm URL per exact
version); a dependency update that adds or changes a platform package must update that file after
reviewing each licence. Notable licences and attributions are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Mastra's `ee/` directories are not Apache-2.0; lint
rejects importing them from our code, and `@mastra/server` and `@mastra/hono` too, because
`@mastra/server` imports `@mastra/core/auth/ee` (ADR 0004). `@mastra/core` itself still loads its
compiled ee auth code, which runs only with an FGA provider configured; see ADR 0004 and
THIRD_PARTY_NOTICES.
