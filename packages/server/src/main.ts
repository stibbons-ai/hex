import { resolve } from "node:path";
import {
  dateExtractorLayer,
  imapMailboxLayer,
  isLoopbackHost,
  smtpMailerLayer,
} from "@hex/adapters";
import { closeInOrder } from "./close";
import { loadChatConfig } from "./channels";
import { loadForwardingConfig, loadIntakeConfig, loadMailboxConfig } from "./config";
import { startServer } from "./index";
import { INTAKE_WORKFLOW_ID, createIntakeRuntime, createIntakeWorkflow } from "./intake-workflow";
import { shutdownOnce } from "./lifecycle";
import { listenAddress } from "./listen-address";
import { dataPaths } from "./paths";

// First: a bad HEX_HOST or HEX_PORT fails before any file is read or opened.
const { hostname, port } = listenAddress();
if (!isLoopbackHost(hostname)) {
  console.warn(
    `hex: listening on ${hostname}, beyond loopback: the server has no authentication, so anyone who can reach this address can use it; in a container, publish the port on 127.0.0.1 only (ADR 0005)`,
  );
}
// HEX_CONFIG names the config file (chat and Intake settings); unset or empty runs without chat.
const configPath = process.env.HEX_CONFIG ? resolve(process.env.HEX_CONFIG) : undefined;
const chat = configPath ? await loadChatConfig(configPath, process.env) : undefined;
if (!chat) {
  console.log(
    configPath
      ? `hex: chat off: ${process.env.HEX_CONFIG} configures no channels`
      : "hex: chat off: HEX_CONFIG is not set",
  );
}
const { category, model } = await loadIntakeConfig(configPath);
// Off without targets; with one enabled, missing SMTP settings fail startup, naming the variable.
const forwarding = await loadForwardingConfig(configPath, process.env);
// Off without a mailbox section; with one, missing IMAP settings fail startup, naming the variable.
const mailbox = await loadMailboxConfig(configPath, process.env);
if (!mailbox) {
  console.log(
    configPath
      ? `hex: mailbox off: ${process.env.HEX_CONFIG} configures no mailbox`
      : "hex: mailbox off: HEX_CONFIG is not set",
  );
}
const paths = dataPaths(process.env);
// Built now, so a ledger that can't be opened, or a mailbox that can't be reached or logged into
// (within 60 s), fails startup instead of every later Intake run (the runtime keeps a failed
// build); disposed after the server stopped.
const intakeRuntime = createIntakeRuntime(paths, {
  dateExtractor: dateExtractorLayer(model),
  mailer: forwarding && smtpMailerLayer(forwarding.smtp),
  mailbox: mailbox && imapMailboxLayer(mailbox.imap),
});
/** Disposes the Intake runtime after a failed start; a failure there is logged, not rethrown. */
const disposeAfterFailure = (error: unknown) =>
  intakeRuntime
    .dispose()
    .catch((disposeError: unknown) => {
      console.error(
        "hex: closing the Intake ledger and mailbox after a failed start also failed",
        disposeError,
      );
    })
    .then(() => {
      throw error;
    });
await intakeRuntime.context().catch(disposeAfterFailure);
const starting = startServer({
  databasePath: paths.databasePath,
  observabilityPath: paths.observabilityPath,
  hostname,
  port,
  workflows: {
    [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime: intakeRuntime, category, forwarding }),
  },
  ...(chat ? { chat } : {}),
  ...(mailbox ? { mailbox: { runtime: intakeRuntime, pollMs: mailbox.pollMs } } : {}),
}).then(
  (server) => ({
    ...server,
    stop: () => closeInOrder([() => server.stop(), () => intakeRuntime.dispose()]),
  }),
  disposeAfterFailure,
);
// Registered before the server finishes starting, so a signal from here on still shuts down
// cleanly. A signal that arrives earlier, while the modules load, the config is read or the
// Intake ledger opens (up to its 5 s busy timeout), gets the default (kill).
const shutdown = shutdownOnce(starting, {
  exit: (code) => process.exit(code),
  error: (message, cause) => console.error(message, cause),
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const server = await starting;
console.log(`hex listening on ${server.url}`);
