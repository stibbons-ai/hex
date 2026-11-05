// Entry of the boot resumption test (boot.test.ts): hex's server as `main.ts` starts it, but on an
// in-memory Mailbox (a real one needs an IMAP server) seeded with the `.eml` files named in argv,
// in the data directory argv[2]. The model is `openai/…` (point OPENAI_BASE_URL at a fake);
// Forwarding goes to one target through the SMTP server on 127.0.0.1 at HEX_SMTP_PORT. Mastra's
// console logger logs at debug (warnings to stderr, the rest to stdout), the watcher's lines
// among them. Prints `booted` once the boot sweep settled (the watcher starts alongside it), and
// `moved <n> <Message-ID> to <folder>` for each move, so the test can follow from outside;
// SIGTERM stops it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Mailbox, dateExtractorLayer, outcomeFolder, smtpMailerLayer } from "@hex/adapters";
import { ConsoleLogger } from "@mastra/core/logger";
import { Effect, Layer, Redacted } from "effect";
import { startServer } from "../src/index";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { memoryMailbox } from "./memory-mailbox";

const [directory, ...emls] = process.argv.slice(2);
if (!directory) throw new Error("usage: boot-entry <data directory> <.eml>...");
const memory = memoryMailbox();
for (const eml of emls) memory.deliver(await readFile(eml));
const mailbox = Layer.effect(
  Mailbox,
  Effect.map(Mailbox, (inner) => ({
    ...inner,
    moveMessageId: (messageId: string, to: "processed" | "failed") =>
      inner
        .moveMessageId(messageId, to)
        .pipe(
          Effect.tap((moved) =>
            Effect.sync(() => console.log(`moved ${moved} ${messageId} to ${outcomeFolder(to)}`)),
          ),
        ),
  })),
).pipe(Layer.provide(memory.layer));
const forwarding = {
  from: "hex@example.com",
  targets: [{ name: "sevdesk", to: "autobox@sevdesk.example" }],
};
const runtime = createIntakeRuntime(
  { databasePath: join(directory, "mastra.db"), outboxDirectory: join(directory, "outbox") },
  {
    dateExtractor: dateExtractorLayer("openai/gpt-5.4-mini"),
    mailer: smtpMailerLayer({
      host: "127.0.0.1",
      port: Number(process.env.HEX_SMTP_PORT),
      security: "plain",
      user: Redacted.make("hex"),
      password: Redacted.make("not-a-secret"),
    }),
    mailbox,
  },
);
const server = await startServer({
  databasePath: join(directory, "mastra.db"),
  observabilityPath: join(directory, "observability.duckdb"),
  port: 0,
  logger: new ConsoleLogger({ name: "hex", level: "debug" }),
  workflows: {
    [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER", forwarding }),
  },
  mailbox: { runtime, pollMs: 60_000 },
});
process.once("SIGTERM", () => {
  void server
    .stop()
    .then(() => runtime.dispose())
    .then(() => process.exit(0));
});
await server.booted;
console.log("booted");
