# hex

Daniel's personal agentic assistant (see [GLOSSARY.md](GLOSSARY.md) and [docs/adr](docs/adr)).
This workspace is the skeleton: a Bun server tracer running Mastra behind a small oRPC API, and the
tooling every later slice builds on.

## Install

Requires Bun 1.4.2 (the `packageManager` pin; the
[development shell](#development-shell-and-model-keys) supplies it).

```sh
bun install --frozen-lockfile
```

`bunfig.toml` installs exact versions only and refuses packages published less than three days
ago. Every external dependency version lives in the root `package.json` `catalog`; packages
depend on externals with `catalog:` and on each other with `workspace:*`, and no manifest may use
`overrides` or `resolutions` (ADR 0003). To add a dependency, add the catalog entry first, then
reference it with `catalog:`.

## Development shell and model keys

With **Nix**, **devenv** and **direnv** (its shell hook enabled) installed, authorize the committed
`.envrc` once from the repository root:

```sh
direnv allow
```

or enter the same environment explicitly with `devenv shell`. The shell supplies Bun 1.4.2 (from
the pinned `devenv-nixpkgs`, matching the `packageManager` pin and CI) and Git, exports
`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`, and runs `bun install --frozen-lockfile` before it
opens. A failed install doesn't stop the shell from opening: check the task output. Nothing
requires the shell; CI installs Bun directly, and the scripts set the telemetry variables
themselves.

Live model runs (`bun run eval`, `bun run intake`, the server's chat model) need the model
provider's API key; tests and CI never do. [SecretSpec](https://secretspec.dev) declares the keys
in the committed `secretspec.toml`, and the shell exports them from 1Password on entry.
`secretspec` comes with devenv itself; the 1Password CLI (`op`) comes from the host. Any other way
of setting the variables still works.

The keys are Secure Notes `secretspec/hex/default/<KEY>` in the vault `Hex` of the 1Password
account `my.1password.com`. The shell reads them as a **read-only service account** (provider
`onepassword_service`), so no Touch ID is needed and unattended shells get the keys too. One-time
setup:

1. In 1Password, create the vault `Hex` and a service account with read access to it only.
2. Store its token in the macOS Keychain: `secretspec config provider login onepassword_service`.
3. Add each key with your own account; the read-only service account can't write, so
   `secretspec set` fails. A key is a Secure Note titled `secretspec/hex/default/<KEY>` whose
   `value` field holds the key (fish; `read -s` keeps it off the screen and out of history):

   ```fish
   read -s -P "ANTHROPIC_API_KEY: " value
   op item create --account my.1password.com --vault Hex --category "Secure Note" \
       --title "secretspec/hex/default/ANTHROPIC_API_KEY" --tags automated,hex \
       "project[text]=hex" "key[text]=ANTHROPIC_API_KEY" "value[concealed]=$value"
   set -e value
   ```

4. Check without printing any key, then reload the shell (`direnv reload`, or leave and re-enter
   `devenv shell`):

   ```sh
   secretspec check --explain
   ```

The keys are `ANTHROPIC_API_KEY` (the default Intake and eval model,
`anthropic/claude-haiku-5-5`, or another `anthropic/` `intake.model` or chat model),
`OPENAI_API_KEY` (an `openai/` one) and `GEMINI_API_KEY` (a
`google/` one). `GOOGLE_GENERATIVE_AI_API_KEY`, the variable Mastra's model router reads for
`google/` models, is derived from `GEMINI_API_KEY` and never stored. `HEX_SMTP_USER` and
`HEX_SMTP_PASSWORD` are the SMTP login Forwarding sends with (see [Intake](#intake-dev-command)),
`HEX_IMAP_USER` and `HEX_IMAP_PASSWORD` the IMAP login hex reads the intake mailbox with (see
[Mailbox](#mailbox)).
All are optional, and a missing or rejected service token only warns: the shell still opens, and
a model call without its key fails.

How it works: `enterShell` in `devenv.nix` runs `secretspec export` and exports the result into
the live shell. The keys are never set through devenv's `env`, which would write them into the
world-readable Nix store, and devenv's own SecretSpec integration (`secretspec.enable`) stays off:
it would fetch the keys a second time and refuse to open the shell when the token is missing.
Every process in the shell, including an AI coding agent started there, sees the keys. To read
them from another store, set the provider on entry. Setting `SECRETSPEC_PROVIDER` also makes
devenv resolve the keys itself, a second fetch on top of `enterShell`'s; in an AI agent session
devenv then refuses to open the shell unless a reason is set too, for example
`SECRETSPEC_PROVIDER=keyring SECRETSPEC_REASON="devenv shell: hex model keys" devenv shell`.

## Run

```sh
bun run start
```

The server binds to `HEX_HOST`, default `127.0.0.1` (an IP address, never a name; a non-loopback
address logs a warning that the server has no authentication), on `HEX_PORT` (default `4111`; `0`
picks a free port), and answers only requests whose `Host` header is `127.0.0.1:<port>` or
`localhost:<port>`, or `<HEX_HOST>:<port>` when `HEX_HOST` is a specific address rather than a
wildcard such as `0.0.0.0` (on port 80 also without the port; 403 otherwise, against DNS
rebinding). It stores Mastra's state in a LibSQL file at
`<data dir>/mastra.db`, and the traces, logs and metrics of every agent call and workflow run in
a DuckDB file, `<data dir>/observability.duckdb` (see [Traces and Studio](#traces-and-studio)).
The data directory is `HEX_DATA_DIR`, default `.data` relative to the
working directory (git-ignored at the repository root); it is created on start. Run it from the
repository root.
SIGINT or SIGTERM stops it: the mailbox watcher (see [Mailbox](#mailbox)) stops taking mail and
closes its IMAP connection first, then hex stops taking chat messages and the channels disconnect
(up to 5 seconds), then requests in flight, open streams and chat replies included, and a channel
still disconnecting get 5 more seconds before they are closed (the cut-off is logged), then Mastra
shuts down. Mastra's shutdown doesn't wait for an Intake run still going: closing the store and
the process exiting cut it off, so it stays active in `mastra.db` and resumes at the next start;
one that finishes within the stop's grace can no longer move its mail; for a processed Intake,
the next start's first look moves it. A second signal of the same kind kills it at once.

Once listening, the server restarts every workflow run a stopped or killed hex left active in
`mastra.db` (Mastra's `restartAllActiveWorkflowRuns()`, which hex calls itself since it has no
Mastra deployer, ADR 0004; a sweep that fails is logged as an error) and starts the mailbox
watcher alongside, so a run that hangs on resuming doesn't hold up all intake. They never race
for one Intake: a run to resume stays active in `mastra.db` until it ends, and the watcher leaves
the Intake of every active run alone. A resumed run starts again at the step that was cut off, from its start, with
the finished steps' outputs restored from the run's snapshot; the ledger makes repeating that
step safe (a target or Document recorded is skipped), except for what the cut-off step did but
hadn't recorded yet: a send the server accepted is sent again (see step 3 under
[Intake](#intake-dev-command)), and a Document written to the Outbox is filed again, as a second
copy `name (1).pdf`. A run whose previous process still held its ownership lease (Mastra's, 15 s
after a kill) is skipped by that sweep and restarted by Mastra once the lease lapses; until then
the watcher leaves its Intake alone, warning once with the run's id. A run of the watcher's own
still going after 10 minutes is a warning, again every 10 minutes, naming the run and its Intake:
the watcher takes no other mail meanwhile.

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

Mastra's own REST routes (`/api/...`) are not served, so Studio and other clients of those routes
don't work against this entrypoint; Studio runs as its own dev-only server instead.

## Container

One `docker compose up` runs hex on this Mac (OrbStack or Docker Desktop, arm64): the image is
built locally from the `Dockerfile` and never pushed anywhere (ADR 0005).

```sh
cp .env.example .env            # then set HEX_OUTBOX_HOST_DIR, and the model keys you use
mkdir -p ~/hex-outbox           # the folder HEX_OUTBOX_HOST_DIR names must exist
docker compose up --build -d
docker compose ps               # STATUS "Up … (healthy)" once /health answers
curl http://127.0.0.1:4111/health   # {"status":"ok"}
docker compose logs -f hex
docker compose down             # stops it; the data volume stays
```

- **Image**: distroless (glibc, non-root uid 65532) with `bun`, the server as a Bun JS bundle
  (`bun scripts/build-server.ts`, ADR 0002) and a production install of only LibSQL's and
  DuckDB's native addons, pruned from `bun.lock` to the target platform, plus Mastra's
  model-capability metadata copied beside them. Its `HEALTHCHECK` runs `/app/healthcheck.js`
  with `bun` (no shell or curl in the image); `/app/smoke.js` checks that model capabilities
  resolve and that LibSQL and DuckDB open, as CI does for every change (`image` job, on GitHub's
  arm64 runner).
- **Data** lives in the named volume `hex_hex-data`, mounted at `/data`: `mastra.db` (LibSQL)
  and `observability.duckdb` (DuckDB). `docker compose down -v` deletes it.
- **Outbox**: the host folder `HEX_OUTBOX_HOST_DIR` (required; compose refuses to start without
  it and never creates it) is bind-mounted at `/outbox`. Nothing else from the host is mounted:
  never Proton Drive or the Archive. On Linux the folder must be writable by uid 65532.
- **Secrets** stay in `.env`, which is git-ignored; `.env.example` lists every variable with
  empty values. hex reads its own secrets (`HEX_SMTP_USER`, `HEX_SMTP_PASSWORD`,
  `HEX_IMAP_USER`, `HEX_IMAP_PASSWORD`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) as Effect
  `Config.Redacted`; Mastra's model router reads the model keys (`OPENAI_API_KEY`, …) straight
  from the environment.
- **Pinned settings**: `compose.yaml` sets `HEX_HOST=0.0.0.0`, `HEX_PORT=4111`,
  `HEX_DATA_DIR=/data`, `HEX_OUTBOX_DIR=/outbox`, `MASTRA_TELEMETRY_DISABLED=1` and
  `DO_NOT_TRACK=1` under `environment:`, which a `.env` line can't override. No config file is
  mounted yet, so chat, Forwarding and the mailbox watcher stay off (`hex: chat off: HEX_CONFIG
  is not set`, `hex: mailbox off: HEX_CONFIG is not set`).
- **Network**: inside its container the server listens on every interface, which is why it logs
  the no-authentication warning; the port is published on the Mac's loopback only
  (`127.0.0.1:4111:4111`). Never publish it as `-p 4111:4111` or `"4111:4111"` without
  `127.0.0.1:`: that hands the unauthenticated server, your Documents and your model keys to the
  network. Keep the host port equal to the container's 4111 too: the `Host` header check only
  allows `127.0.0.1:4111` and `localhost:4111`, so another host port answers 403. The loopback
  publish keeps the LAN out; the Mac itself (through the container's IP) and other containers on
  the compose network still reach port 4111 directly, with only the `Host` check in the way, which
  browsers can't forge (ADR 0005).

## Traces and Studio

hex traces every agent call and workflow run of the server (`bun run start`) with Mastra's
observability into the DuckDB file `<data dir>/observability.duckdb` (`@mastra/duckdb`), next to
`mastra.db`, which keeps memory, workflow state and the Intake ledger. `bun run intake` is not
traced: it runs beside a running server, which holds the DuckDB file (see below). The storage
exporter is the only exporter: nothing is sent anywhere. Spans are written in batches a few
seconds apart; a normal stop (SIGINT/SIGTERM) flushes them, a killed process loses the unwritten
ones, and so does a final flush that fails (the exporter logs it; the stop still succeeds).

To look at them, open Mastra Studio (dev machine only):

```sh
bun run studio   # stop `bun run start` first
```

then browse to `http://localhost:4111` (or `PORT`): Observability → Traces lists the runs with
their spans, input and output, Logs and Metrics the rest. Studio serves the same Mastra as hex
(`packages/server/src/mastra.ts`, built from `packages/server/src/studio/index.ts`) on the same
`mastra.db` and `observability.duckdb`, with the same `HEX_DATA_DIR`, `HEX_OUTBOX_DIR` and
`HEX_CONFIG`: the Intake workflow and, when `HEX_CONFIG` is set, the chat agent with its model,
memory and working memory, but without its channels. Studio never connects to Slack or Signal;
calling the agent or running the Intake from Studio does the real thing (model calls, files in
the Outbox, ledger entries) and is traced like any other run.

- **One process at a time.** DuckDB lets one process open the file. While Studio runs, `bun run
  start` fails at startup with `Could not set lock on file ".../observability.duckdb":
  Conflicting lock is held`. The other way round, Studio starts, but every storage call (memory
  and workflow runs too, not only traces) fails with that error and is retried on the next call
  until hex stops. Stop one before starting the other.
- **How it runs.** `bun run studio` is `bun run studio:build && bun run studio:start`: the
  `mastra` CLI, through `bunx --minimum-release-age 259200 mastra@1.36.0` (never a hex
  dependency), runs `mastra build --studio` into the git-ignored `.mastra/output`, then
  `mastra start` serves it. A manifest rule requires the exact pin and the release-age flag, and
  the same version in both scripts. Which Mastra server code that pulls in, its versions and
  peer range against hex's `@mastra/core`, what the build installs into `.mastra/output`, and why
  the bundle's enterprise (ee) import stays off hex's runtime: see
  [ADR 0004](docs/adr/0004-orpc-api-instead-of-mastra-routes.md). `mastra dev` does not work
  with hex (same ADR), so there is no hot reload: rerun `bun run studio` after changing code.
  The build's `Invalid Mastra config` warning is harmless. Studio prints the data files it uses
  (`hex studio: data in …`) at startup.
- Mastra's and Bun's telemetry stay off (`MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`).

## Intake (dev command)

```sh
bun run intake path/to/mail.eml
```

runs the Intake workflow once, in process, on one `.eml` Intake and prints what it did: the
Documents it filed (paths relative to the Outbox; a Document filed by its received date is
marked `(no usable Document date; filed by received date)`), that the Intake has no Documents, or
that it was already processed; then each target that has the Documents (`forwarded to sevdesk`,
`already forwarded to sevdesk earlier`). It exits with code 1 and a message on a file it can't
read or that is no mail, an Intake without a Message-ID or without a usable received date, a
config it can't use (including SMTP settings missing while a target is enabled), or a failed run.
A failed run still prints this run's Filings and the targets recorded as having the Documents, and the
message names each failed branch once (`forwarding to paperless: …`, `filing: …`), then the
failed run's count (`failed run 1 of 5: …`, see [Mailbox](#mailbox)). Run it from the
repository root. The dev command has no mailbox: it never connects to IMAP, moves no mail and
retries nothing itself (run it again whenever you like), but it counts its failed runs in the
ledger like the server does, as does a run started from Studio, so its 5th failed run of one
Intake starts the count afresh. The same workflow is registered with the server as `intake`
(`workflows.start` with an Intake as `inputData`); the server opens the Intake ledger at startup
and fails to start when it can't, or when a Forwarding target is enabled without usable SMTP
settings, and runs it for every mail in the intake mailbox (see [Mailbox](#mailbox)).

The workflow, in order:

1. **Ledger check**: an Intake whose Message-ID (trimmed, without any layers of `<>`) is in the ledger was
   processed before; the run ends there, files or forwards nothing and moves its mail to
   `hex/processed` (as in step 7).
2. **Document detection** (`packages/domain/src/document.ts`): a Document is a PDF (also
   `application/octet-stream` named `*.pdf`) or a raster image (JPEG, PNG, GIF, WebP, HEIC/HEIF,
   TIFF, BMP). Not Documents: any part the HTML body references by `cid:` (signature images,
   logos, whatever their Content-Disposition), images under 10 KiB of content
   (`MIN_IMAGE_DOCUMENT_BYTES`: tracking pixels, icons; a PDF is never dropped for size), SVG,
   and every other type (`.ics`, text, office files). An attached mail (`message/rfc822`) is
   one non-Document attachment, never unpacked: the Documents inside it are not filed. An
   unreferenced `inline` image or PDF counts, since Apple Mail sends scans that way.
3. **Forwarding** (`packages/adapters/src/mailer.ts`): to each enabled target, one mail by SMTP
   carrying all of the Intake's Documents as attachments, bytes unchanged, each under its
   detected file name (Filing may add a collision suffix such as ` (1)` to its own copy) and the
   type its content shows when hex recognises it (PDF, JPEG, PNG, GIF, WebP: a PDF declared
   `application/octet-stream` goes as `application/pdf`), else the type the sender gave it;
   nothing else of the mail (no body, no inline decoration). Its subject is the original subject
   (control characters replaced by spaces), or `Documents forwarded by hex` when there was none;
   its plain-text body names the original Message-ID and sender. Targets go one after another, in
   the config's order. An Intake without Documents forwards nothing. Each Forwarding is recorded
   in the ledger right after the server accepted the mail (tried 3 times, 100 ms then 200 ms
   apart, when the ledger fails); a target recorded for this Intake is skipped. A refused or
   failed send (connection, TLS, login, a rejected recipient) fails that target's branch only;
   the error names the target address, the server and the SMTP stage (e.g.
   `EENVELOPE at RCPT TO`) and keeps at most 300 characters of the server's reply, never the
   credentials. A send the server accepted but the ledger could not record fails the branch as
   `sent, but recording it failed …; running this Intake again sends it again`: that target does
   get the Intake a second time on the next run.
4. **Document dates** (`packages/adapters/src/date-extractor.ts`): a model reads each
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
   refusing the file) fails the Filing branch before any of its Documents is filed, so running
   the Intake again retries it; transient errors (rate limit, overload, a dropped or refused connection)
   are retried twice first, at least 3 s apart (longer when the provider asks, up to 30 s). A
   Document the provider rejects every time (e.g. an encrypted or oversized PDF) keeps failing
   its Intake until it is handled by hand. The error names the Document, the model and the HTTP
   status, if any, and keeps at most 300 characters of the provider's message.
5. **Filing**: each Document goes to `<Outbox>/YYYY-MM/<Category>/` by its Document date when
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
   kill mid-write can leave one behind. Each Filing is recorded in the ledger once the file is in
   place.
6. **Ledger**: when every branch succeeded, the Intake is recorded as processed with its
   Filings, also when it had no Documents.
7. **Mail**: every copy of the Intake's mail in the watched folder, found by its Message-ID
   (compared trimmed and without any layers of `<>`, as the ledger does, so a re-delivered mail moves too), goes
   to `hex/processed`. A failed run counts the failure instead (see [Mailbox](#mailbox)); on its
   5th failed run, the Intake failed permanently and its mail goes to `hex/failed`. No copy in
   the folder (an Intake from the dev command or `workflows.start`, or moved already) moves
   nothing. A move to `hex/processed` that fails (the IMAP server unreachable) is reported, the
   outcome stands, and the watcher's next look at the folder moves the mail; one to `hex/failed`
   that fails leaves the mail in the folder with its count ended, so the watcher runs it afresh.

**Branches and retries.** Forwarding to each target and Filing (steps 4 and 5) are branches:
every run attempts each of them, even when another failed, unless the ledger can't be read or an
unexpected defect occurs; then the run fails at once. An unreadable ledger fails it before
anything is sent; a defect can come after earlier targets were sent to, and the failed run's
output then doesn't list them (the ledger has those that were recorded, so a re-run skips them). When any branch
failed, the run fails, naming each failed branch and what happened to the mail, and the Intake is
not recorded as processed.
Running the Intake again (`bun run intake` on the same `.eml`, or `workflows.start` with the
same Intake) repeats only the branches the ledger has no record of: a target recorded as having
the Intake is not sent it again, and a Document recorded as filed is neither read by the model
again nor filed again. A branch done but not recorded (the ledger failing right after) is done
again: a send as described in step 3, a Filing as a second copy `name (1).pdf`. The mailbox
watcher runs one Intake at a time and never two runs of one Intake; running the same Intake
twice at the same time some other way (`workflows.start` or `bun run intake` beside the server's
watcher) is unsupported and may duplicate Forwardings and Filings.

| Setting                        | Meaning                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEX_DATA_DIR`                 | Data directory with `mastra.db`, as for the server                                                                                                                  |
| `HEX_OUTBOX_DIR`               | The Outbox; default `<data dir>/outbox`                                                                                                                             |
| `HEX_CONFIG` `intake.category` | Category to file under; only `"ER"`, the default without the file, `intake` or `category`                                                                           |
| `HEX_CONFIG` `intake.model`    | Mastra model-router id (`provider/model`) that reads Document dates; default `anthropic/claude-haiku-5-5` (chosen by the eval on 2026-11-05, see [Evals](#evals))   |
| `HEX_CONFIG` `eval.models`     | The models `bun run eval` compares, `provider/model` each (see [Evals](#evals)); checked, but not used, by the server and the Intake                                |
| `ANTHROPIC_API_KEY`            | API key for the default model; another provider takes its own variable (e.g. `OPENAI_API_KEY`), never the config                                                    |
| `HEX_CONFIG` `forwarding`      | Forwarding: `from` (the sender address) and `targets`, each name → `{ "to": address, "enabled": true/false }`; off when absent                                      |
| `HEX_SMTP_HOST`                | SMTP server to forward through; required (as are user and password) once a target is enabled                                                                        |
| `HEX_SMTP_PORT`                | SMTP port; default 465                                                                                                                                              |
| `HEX_SMTP_SECURITY`            | `tls` (implicit TLS), `starttls` (required, never AUTH in plaintext) or `plain` (loopback IP address only, e.g. `127.0.0.1`); default `tls` on 465, else `starttls` |
| `HEX_SMTP_USER`                | SMTP login, read as a redacted secret                                                                                                                               |
| `HEX_SMTP_PASSWORD`            | SMTP password, read as a redacted secret: never in the config, an error, a log or the dev command's output                                                          |
| `HEX_CONFIG` `mailbox`         | The intake mailbox the server watches; see [Mailbox](#mailbox)                                                                                                      |

The config file is the one described under [Chat](#chat-slack-signal), so its `chat` section is
required:

```json
{
  "chat": { "model": "anthropic/claude-opus-5-5", "channels": {} },
  "intake": { "category": "ER", "model": "anthropic/claude-haiku-5-5" },
  "forwarding": {
    "from": "hex@example.com",
    "targets": {
      "sevdesk": { "to": "autobox@sevdesk.example", "enabled": true },
      "paperless": { "to": "bill@paperless.example", "enabled": true }
    }
  }
}
```

A target's name (lowercase letters, digits and `-`, starting with a letter) is the key the
ledger records its Forwardings under, so renaming a target makes it a new one. Addresses are
bare (`local@domain`, no display name, one per target). A disabled target sends nothing and
records nothing; with no target enabled (or no `forwarding` section) Forwarding is off and no
SMTP setting is needed. Plaintext SMTP (`HEX_SMTP_SECURITY=plain`) is refused unless the host is
a loopback IP address, an IPv4 `127.x.x.x` or `::1`, so the credentials never cross a network
unencrypted. Names, `localhost` included, are refused: the SMTP client resolves a name first
through DNS, before `/etc/hosts`, so it could reach another machine; use `127.0.0.1`. The SMTP
Mailer
itself refuses it too, without connecting. The SMTP settings are
read as Effect `Config` from the environment: the login (`HEX_SMTP_USER`, `HEX_SMTP_PASSWORD`) is
declared in `secretspec.toml`, so the development shell exports it like the model keys; set
`HEX_SMTP_HOST`, `HEX_SMTP_PORT` and `HEX_SMTP_SECURITY` yourself.

The development shell exports the API keys (see
[Development shell and model keys](#development-shell-and-model-keys)). hex doesn't check at
startup that the model's key is set: without it every Intake with a Document hex sends to the
model fails until it is.

The tests answer as OpenAI does (a fake OpenAI on loopback) or refuse the default model before
any call (no Anthropic key); the default, `anthropic/claude-haiku-5-5`, was checked against the
real provider by the eval's run of 2026-11-05 (see [Evals](#evals)). The answer schema goes to the
provider as JSON Schema with `additionalProperties: true` and safe-integer bounds (±(2^53−1)); a provider
that insists on strict JSON Schema (e.g. some OpenAI-compatible ones) may reject it, which fails
every run until `intake.model` names another model.

The ledger is the table `hex_intake_ledger` in `mastra.db`, created on first use: one row per
Intake with `message_id` (the key), `processed_at`, `document_count` and `filings` (JSON, one
`{ "index": …, "path": …, "fellBack": … }` per Document: its position among the attachments,
0-based, where it landed, and `true` when it was filed by the received date: the model answered
no usable Document date, or hex never sent the Document to a model (see step 4)). Entries
recorded before #7 (when hex filed every Document by the received date) have no `fellBack` and
read back without it. The workflow's result (`IntakeResult`)
carries the same Filings, also for an Intake already processed, its Forwardings (`forwarded`
by this run or `forwarded-earlier`) and what happened to its mail (`mail`: `moved` with the
folder and the number of copies, `not-in-mailbox`, or `not-moved` with the reason); a failed
run's `IntakeRunError` says it too (`kept-for-retry` when the Intake has runs left), unless the
run ended before step 7 or the ledger couldn't record the failed run there. Each branch is
recorded as it succeeds, before the Intake is
processed, in two more tables keyed by `message_id`: `hex_intake_forwardings` (`target`,
`forwarded_at`; one row per target) and `hex_intake_filings` (`document_index`, `path`,
`fell_back`, `filed_at`; one row per Document). Recording a branch again keeps the first row
(`ON CONFLICT DO NOTHING`), as does recording an Intake again (a resumed run). Intakes processed
before #8 have no rows there and read back with no Forwardings. A fourth table,
`hex_intake_failed_runs` (`message_id`, `run_id`, `failed_at`, `ended`), has one row per failed
run of an Intake, so a run repeated after a restart counts once; the rows stay after a later
success. Failing permanently marks the Intake's rows `ended` and, in the same transaction,
deletes all but the row of the run it failed on: no row then counts, and that run, repeated
after a restart, still fails the Intake permanently instead of counting 1. When the watcher
fails an Intake permanently itself (5 failed runs counted, the process gone before it ended
them), no row is kept.

Since #9, a Message-ID is keyed without every layer of `<>` (`<<a@b>>` is `a@b`); Content-IDs
are compared the same way. Before, the ledger took one layer off and `readEml` another, so mail
read from a file was already keyed without two layers. Only a ledger row of an Intake given with
three or more layers, or with two through `workflows.start` or Studio, keeps its old key and no
longer matches; such an Intake would run again. None is known to exist (no such Message-ID is
valid), so the rows aren't rewritten.

### Mailbox

With a `mailbox` section in the config file, the server watches one folder of an IMAP mailbox
(over `imapflow`, `packages/adapters/src/mailbox.ts`) and runs the Intake workflow once per mail
in it, an Intake being one incoming mail:

```json
{
  "chat": { "model": "anthropic/claude-opus-5-5", "channels": {} },
  "mailbox": { "folder": "INBOX", "pollSeconds": 60 }
}
```

| Setting                            | Meaning                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEX_CONFIG` `mailbox`             | The intake mailbox; without it there is no watcher (`hex: mailbox off: …` at startup, `hex: mailbox on: watching …` with it) and no IMAP setting is needed |
| `HEX_CONFIG` `mailbox.folder`      | The watched folder; default `INBOX`                                                                                                                        |
| `HEX_CONFIG` `mailbox.pollSeconds` | How long hex waits after a look without news before looking again, 1 to 3600 seconds; default 60                                                           |
| `HEX_IMAP_HOST`                    | IMAP server; required (as are user and password) with a `mailbox` section                                                                                  |
| `HEX_IMAP_PORT`                    | IMAP port; default 993                                                                                                                                     |
| `HEX_IMAP_SECURITY`                | `tls`, `starttls` (required, never LOGIN in plaintext) or `plain` (loopback IP address only); default `tls` on 993, else `starttls`                        |
| `HEX_IMAP_USER`                    | IMAP login, read as a redacted secret                                                                                                                      |
| `HEX_IMAP_PASSWORD`                | IMAP password, read as a redacted secret: never in the config, an error, a log or a result                                                                 |

A setting missing or unusable fails startup, naming the variable (never its value), as for SMTP;
plaintext IMAP is refused for anything but a loopback IP address, for the same reason. The folder
can't be blank or one of hex's outcome folders (in any letter case, with either delimiter, under
`INBOX` or not). The server connects, logs in and opens the folder
at startup and fails to start when it can't within 60 s (an unreachable server, wrong
credentials, a missing folder); the error names the server, the folder and the IMAP stage, never
the credentials. hex requires the IMAP MOVE extension (RFC 6851; Dovecot, Gmail, Fastmail and
Cyrus have it) and fails to start, naming it, on a server without: moving mail as COPY, `\Deleted`
and EXPUNGE would set flags and, without UIDPLUS, could expunge other mail marked deleted. A
move or search the server refuses names the server's reason (`[OVERQUOTA] …`).

**Watching.** hex looks at the folder once listening, alongside its boot sweep (see [Run](#run)),
again whenever the server announces new mail (IMAP IDLE, which the connection enters after 1 s
without a command; on a server without IDLE, imapflow's NOOP every 2 minutes can bring the news
too), and `pollSeconds` after a look without news, since an IDLE connection can die without
notice. While IDLE, a server silent for 90 s gets a NOOP, and no answer within another 90 s counts
as a lost connection; a command left unanswered for 90 s counts as lost at once. A look that runs Intakes takes as
long as they do, so looks can be further apart than `pollSeconds`. Every mail in the folder
counts, read or not; hex fetches mail with `BODY.PEEK`, so it never marks one read, and never
sets or reads flags. Each look goes through the folder's mail in order, one run at a time:

- a mail that can't become an Intake (no usable Message-ID: missing, or blank without its
  brackets; no usable received date; not a mail) goes
  to `hex/failed` at once, without a run, the reason logged;
- an Intake already processed (in the ledger) only has its mail moved to `hex/processed`;
- an Intake with a run active in `mastra.db` (one resumed after a restart, say) is left alone,
  with a warning once, naming the run, as long as the run stays active;
- copies of one Message-ID start one run, which moves them all;
- an Intake whose last run failed waits for its retry (below); any other starts a run.

Decisions and actions go by the Message-ID hex reads from the mail, the one runs, the ledger and
the active runs know it by. The server's reading (its ENVELOPE) decides only to pass over a mail
without fetching it: another copy seen in this look, an active run, an Intake held back in memory
(below), a retry still waiting; when
the two readings differ, a mail can be held back by the server's reading of another Intake's id.
The outcome folders `hex/processed` and `hex/failed` are created on first use, with the server's
hierarchy delimiter and under its personal namespace (`hex.processed` on a server that separates
folders with `.`, `INBOX.hex.processed` on one whose folders all sit under `INBOX.`). A failure
with one mail (the server refusing to hand it out or move it) is logged as a warning naming its
UID and the Message-ID the server reads, and the look goes on with the next mail. A lost
connection, UIDs that changed meaning since the listing (UIDVALIDITY), a failure to list the
folder or the active runs or to wait for news (all at warn, naming the mail when there is one),
or anything unexpected (at error) ends the look; hex tries again after 1 s, doubling up to 60 s,
one line per attempt, for as long as it runs; `/health` stays `ok` meanwhile. A move that fails
is a warning; a mail of a processed Intake stays and a later look moves it. Every failed-run
consequence (a mail moved to `hex/failed`, or kept for a retry) is a warning too. For a run of
the watcher's own, a move to `hex/failed` that fails is tried once more, by Message-ID and then
by UID, and after one that went through, the mail the watcher looked at goes too if still there
(a copy whose Message-ID the server reads differently). When the retries fail too (or the run
was one resumed at boot, which the watcher doesn't follow), the Intake's count is ended already,
so the next look runs it afresh, a new series of 5 runs, as the warning says. When the watcher's
retry finds the mail gone, the first move's answer was likely lost although it went through: the
line says so, pointing at `hex/failed`, instead of a fresh series. A failed run the ledger can't
count (its writes failing while reads work) is an error, and the watcher holds the Intake back in
memory for 5 minutes, the first retry delay, instead of running it on every look.

**Outcomes and retries.** A processed Intake's mail goes to `hex/processed`. A failed run leaves
it in the folder and counts the failure; the Intake is run again no sooner than 5 minutes after
its first failed run, 10 after its second, 20 after its third and 40 after its fourth (constants,
not settings); its 5th failed run fails it permanently, about 75 minutes after the first, and
its mail goes to `hex/failed`, the count starting afresh: move it back to the folder and hex
tries it 5 more times, repeating only the branches that failed. A run that fails before it gets
to step 7 (an unreadable ledger, a defect), or whose start fails, is counted by the watcher
instead, unless the ledger shows the Intake processed nonetheless: then its mail goes to
`hex/processed`.

**Limits.** One hex process per mailbox and data directory. An Intake whose run stays active in
`mastra.db` without resuming (Mastra gave up restarting it) waits for the next start; an active
run whose input can't be read is a warning, since it can't guard its Intake. The watcher uses the
Message-ID the server reports for each mail (its ENVELOPE) only to pass over a mail without
fetching it (see above); when the run then finds no copy by Message-ID (a server reading the
header differently from hex), the watcher moves that mail by its UID. Studio (`bun run studio`)
never watches the mailbox and never restarts runs; a run started there moves no mail.

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
  environment variable (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), which the development
  shell exports (see [Development shell and model keys](#development-shell-and-model-keys)).
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
  hadn't finished: a reply cut off by the stop grace (10 seconds in all) or a crash, and messages
  signal-cli took off Signal after hex was gone (it notices only at its next keep-alive, within
  about 15-30 s, longer when the host itself is gone). Messages sent while no event stream was
  connected stay at Signal and arrive once hex connects (with `--receive-mode on-connection`).
  Limits:
  - lost: everything signal-cli held for replay when signal-cli itself restarts, and anything
    older than its last 1000 events;
  - lost: a message waiting behind a reply in progress in the same conversation when hex stops or
    crashes: its handling counts as finished once it is queued, and the queue lives in memory;
  - lost: until hex has finished its first event and every one before it (on a new database, or
    the first start after this upgrade), there is no cursor, so a restart replays nothing;
  - lost, during shutdown: a message arriving after hex began stopping is dropped and the cursor
    moves past it;
  - answered twice: a message whose reply went out just before a crash, before its handling
    finished and the cursor was written; and, during shutdown, one whose reply and last cursor
    write didn't finish within the 10 seconds of both stop graces.
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
Document detection (`detectDocuments`) and Document date extraction (the DateExtractor), and
compares the configured models side by side on accuracy, cost and latency. Run it by hand, with
real API keys (the [development shell](#development-shell-and-model-keys) exports them): it
makes at most one model call per labelled Document and model (none for one not sent), plus the
DateExtractor's retries of transient provider errors (up to 2 per call), one call at a time. No
CI job runs it against a real model (`bun run check` runs its test against a loopback fake), and
it refuses to run (exit 1, nothing written, no model call) when the `CI` environment variable is
set to a non-empty value.

```sh
bun run eval                                   # the committed synthetic set
HEX_EVAL_FIXTURES=~/hex-fixtures bun run eval  # your own folder
ANTHROPIC_API_KEY=… bun run eval               # outside the development shell
```

- `HEX_EVAL_FIXTURES`: the fixture folder (`expected.json` and its `.eml` Intakes); default
  `packages/eval-harness/fixtures/synthetic/`. Only read, never written.
- `HEX_EVAL_RESULTS`: where reports go; default `eval-results/` in the repo root (git-ignored).
  It must not lie inside the fixture folder.
- `HEX_CONFIG`: the path of hex's config file. The models are its `eval.models`; without that
  section, the one model the Intake uses (`intake.model`, or `anthropic/claude-haiku-5-5` when
  the variable is unset or the file names none). Each model's API key comes from its provider's
  usual variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).
- `HEX_EVAL_PRICES_URL`: where LiteLLM's price data comes from; default
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.

`eval.models` is a list of Mastra model-router ids, at least one, none twice, compared in that
order. The eval reads the config file without requiring its `chat` section, so a file holding
only this works; any other section present must still match the config schema:

```json
{
  "eval": {
    "models": ["anthropic/claude-haiku-5-5", "openai/gpt-5.4-mini", "google/gemini-3.5-flash-lite"]
  }
}
```

The default extraction model, `anthropic/claude-haiku-5-5`, comes from this eval's run on the
synthetic set on 2026-11-05: of the models that read all 14 Document dates right with no failed
call, it cost least ([result on #13](https://github.com/stibbons-ai/hex/issues/13#issuecomment-6668973534)).
It replaced `openai/gpt-5.1-codex-mini`, which the project's OpenAI key could not reach (HTTP 404
on every call).

Relative paths resolve against the directory you ran it from, as for `fixtures:generate`. A label
names an attachment by its original file name or, when it has none, by the name hex would file it
under: `document-<position>.<ext>`, its 1-based position among the mail's attachments and `.pdf`
unless it is an image type. `report.json` lists every attachment by the exact name a label must
use (`report.md` collapses whitespace in names). A label naming no attachment of its `.eml`, or
one of several attachments with that name (such an Intake can't be labelled), or an `.eml` that
can't be read, fails the run before any model call, naming the file and the label; so does a
results folder that can't be created or written to. A failed model call is recorded on its
Document and the run goes on; the command exits 1 after writing the reports, as it does when
every configured model was excluded.

What it measures, per attachment matched to the labels by its file name:

- **Detection precision**: detected attachments that are labelled Documents / detected
  attachments. **Recall**: labelled Documents detected / labelled Documents. A zero denominator
  is not applicable (`null` in JSON, `n/a` in Markdown). Detection involves no model, so it runs
  once per run.
- **Exact accuracy**, per model: labelled Documents whose predicted Document date is the
  labelled day / labelled Documents. **Month accuracy**: the same for year and month. A Document
  labelled undated is right only when no date is predicted; a failed call is always wrong.
- **Cost**, per model: the provider-reported token usage of each answered call priced with
  LiteLLM's price data. A call costs input tokens × `input_cost_per_token` + output tokens ×
  `output_cost_per_token`; when the provider reports cached input tokens and LiteLLM has a
  `cache_read_input_token_cost`, those tokens cost that instead of the input price. Input tokens
  include the cached ones and output tokens the reasoning ones, as Mastra's model router reports
  them, so reasoning tokens are priced at the output price (LiteLLM's
  `output_cost_per_reasoning_token`, which some entries have, is ignored); cache writes are priced
  as input, tiered (long-context) prices are not applied. The total is the sum over the answered
  calls, the cost per Document the total / answered calls. A failed call reports no tokens and
  adds nothing, so in `report.md` a priced total says how many failed calls it leaves out
  (`$0.001620 (1 failed call not counted)`; `report.json` has the total and the failed count). A
  model is **unpriced**, with the reason, and still runs, never costs 0, when the price data
  couldn't be fetched (`price data unavailable: <error>`), has no entry for it
  (`no LiteLLM entry`) or only one whose `litellm_provider` is malformed, when its entry lacks
  `input_cost_per_token` or `output_cost_per_token` (naming which), has one of the three prices
  malformed (naming it), or prices both input and output at zero, when one of its answered calls
  reported no token usage, or when no call answered.
- **Latency**, per call: the wall-clock time of the DateExtractor call, from sending to the
  answer or the failure, retries and their waits included; per model the median and the maximum
  over its calls (answered and failed).

LiteLLM's price data is fetched once per run, before the first model call, and decoded as
untrusted input, field by field; a field that doesn't decode is named, never trusted: a
malformed price (no non-negative number) makes the model unpriced, a malformed
`supports_pdf_input` (no boolean) leaves PDF input unknown while the prices still count, and an
entry whose `litellm_provider` is malformed is named and leaves the model unpriced with PDF input
unknown. An entry that is no object is left out, never the whole file; a fetch that fails,
answers no 2xx, isn't JSON or takes over 30 s leaves every model unpriced and the run goes on. A
model id `provider/model` maps to the first of the entries `<provider>/<model>` and `<model>`
whose `litellm_provider` is the provider, where `google` is LiteLLM's `gemini` (the Gemini API;
as of 2026-11-05 the bare `gemini-…` entries are Vertex AI's): `openai/gpt-5.4-mini` is
`gpt-5.4-mini`, `anthropic/claude-haiku-4-5` is `claude-haiku-4-5`,
`google/gemini-3.5-flash-lite` is `gemini/gemini-3.5-flash-lite`.

**PDF input**: the same entry's `supports_pdf_input` decides whether a model can read the
Documents. A model whose entry says `false` is excluded before any call, even when the entry's
prices are malformed, and listed in both reports with the reason. A model without an entry or
the flag (or with a malformed flag, or only an entry whose `litellm_provider` is malformed), or a
run without price data, is not excluded: its row says
"PDF input unknown". The eval doesn't use Mastra's own model data: as of `@mastra/core` 1.80.0
its `capabilities/<provider>.json` has only a generic attachment list, not PDF input.

Extraction runs on every labelled Document, whatever detection decided, so detection errors don't
reach its figures, and as the Intake workflow runs it: a Document whose content
`documentMediaType` rejects is not sent (predicted no date, counted as not sent), and the answer
is decoded by `documentDateOf`, so no date or no real day is no date. The verdicts come from
deterministic Mastra scorers (`createScorer`, run through the scorer's `run`):
`document-detection`, `document-date-exact` and `document-date-month`. No model judges them: a
set of attachments and a calendar day have exact right answers.

Each run writes `report.json` and `report.md` into its own folder: `<results>/<UTC start
time>_<model>/` for one configured model, e.g.
`2026-11-05T15-26-39-000Z_anthropic-claude-haiku-5-5/`, `<results>/<UTC start time>_matrix/` for
several (`-2`, `-3`… if taken, never overwritten). `report.md` starts with the fixture folder,
start time, duration and price data URL (with the error when the fetch failed), then the
comparison table, one row per evaluated model: exact and month accuracy with counts
(`11/13 (84.6 %)`), failed calls, total cost and cost per Document (or "unpriced"), latency
median and maximum, and PDF input (yes, or "PDF input unknown"); below it each unpriced model's
reason and the excluded models with theirs. Then detection precision and recall with true
positive, false positive and false negative counts, and per Intake the attachment names by
detection verdict; and per model its figures (tokens, LiteLLM entry) and per labelled Document
the expected and predicted date (none, not sent, or the error) with both verdicts, the call's
latency, tokens and cost. The summary on the terminal prints one line per model. `report.json`
decodes with `Report`, exported by `@hex/eval-harness`; `runEval` takes a DateExtractor Layer
per model and the fetched price data, so a test can script both.

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
through a script, set both yourself, or work in the development shell, which exports both.

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
