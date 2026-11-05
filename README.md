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
curl -X POST http://127.0.0.1:4111/rpc/workflows/list # {"json":[]}: the oRPC API
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
- The adapter's receive cursor lives in memory only (Mastra's state adapter persists just
  subscriptions), so a restart starts at live events. Lost are messages hex had received but not
  answered within the 5-second stop grace, or when it crashed, and messages signal-cli took off
  Signal after hex was gone (it notices only at its next keep-alive, within about 15-30 s, longer
  when the host itself is gone). Messages sent while no event stream was connected stay at Signal
  and arrive once hex connects (with `--receive-mode on-connection`).
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

## Packages

| Package             | Holds                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `@hex/domain`       | Pure domain: imports only `effect` and its own files, depends only on `effect` |
| `@hex/adapters`     | Effect Schema → Mastra helper (`toMastraSchema`, ADR 0002); LibSQL storage     |
| `@hex/server`       | `Bun.serve` entrypoint: `/health`, the oRPC API (`contract`) and chat channels |
| `@hex/eval-harness` | Empty until the evaluation slice                                               |

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
