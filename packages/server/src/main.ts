import { resolve } from "node:path";
import { closeInOrder } from "./close";
import { loadChatConfig, loadIntakeConfig } from "./config";
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
const { category } = await loadIntakeConfig(configPath);
const paths = dataPaths(process.env);
// Built on the first Intake workflow run; disposed after the server stopped.
const intakeRuntime = createIntakeRuntime(paths);
const starting = startServer({
  databasePath: paths.databasePath,
  port: parsePort(process.env.HEX_PORT),
  workflows: {
    [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime: intakeRuntime, category }),
  },
  ...(chat ? { chat } : {}),
}).then((server) => ({
  ...server,
  stop: () => closeInOrder([() => server.stop(), () => intakeRuntime.dispose()]),
}));
// Registered before startup finishes, so a signal during startup still shuts down cleanly. A
// signal that arrives while the modules are still loading gets the default (kill).
const shutdown = shutdownOnce(starting, {
  exit: (code) => process.exit(code),
  error: (message, cause) => console.error(message, cause),
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const server = await starting;
console.log(`hex listening on ${server.url}`);
