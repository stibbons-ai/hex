import { resolve } from "node:path";
import { dateExtractorLayer, smtpMailerLayer } from "@hex/adapters";
import { closeInOrder } from "./close";
import { loadChatConfig } from "./channels";
import { loadForwardingConfig, loadIntakeConfig } from "./config";
import { startServer } from "./index";
import { INTAKE_WORKFLOW_ID, createIntakeRuntime, createIntakeWorkflow } from "./intake-workflow";
import { shutdownOnce } from "./lifecycle";
import { dataPaths } from "./paths";

const DEFAULT_PORT = 4111;

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
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
const port = parsePort(process.env.HEX_PORT);
const paths = dataPaths(process.env);
// Built now, so a ledger that can't be opened fails startup instead of every later Intake run
// (the runtime keeps a failed build); disposed after the server stopped.
const intakeRuntime = createIntakeRuntime(
  paths,
  dateExtractorLayer(model),
  forwarding && smtpMailerLayer(forwarding.smtp),
);
/** Disposes the Intake runtime after a failed start; a failure there is logged, not rethrown. */
const disposeAfterFailure = (error: unknown) =>
  intakeRuntime
    .dispose()
    .catch((disposeError: unknown) => {
      console.error(
        "hex: closing the Intake ledger after a failed start also failed",
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
  port,
  workflows: {
    [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime: intakeRuntime, category, forwarding }),
  },
  ...(chat ? { chat } : {}),
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
