// Mastra Studio's entry, dev only: `bun run studio` builds it with `mastra build --studio` into
// the git-ignored `.mastra/output` and serves it with `mastra start`. hex's Mastra, built by the
// server's own wiring (../mastra) on the same data files, with the Intake workflow and the chat
// agent without its channels: Studio never connects to a chat platform, and this module loads no
// adapter package. `mastra start` runs the build in `.mastra/output`, passing the project root
// (where `bun run studio` ran) as MASTRA_PROJECT_ROOT: HEX_CONFIG and the data paths resolve
// against it, as they do for `bun run start`.
import { resolve } from "node:path";
import { dateExtractorLayer, smtpMailerLayer } from "@hex/adapters";
import { createStudioChatAgent } from "../chat";
import { loadChatModel, loadForwardingConfig, loadIntakeConfig } from "../config";
import { INTAKE_WORKFLOW_ID, createIntakeRuntime, createIntakeWorkflow } from "../intake-workflow";
import { createHexMastra, createHexStore } from "../mastra";
import { dataPaths } from "../paths";

const root = process.env.MASTRA_PROJECT_ROOT || process.cwd();
const configPath = process.env.HEX_CONFIG ? resolve(root, process.env.HEX_CONFIG) : undefined;
const { category, model } = await loadIntakeConfig(configPath);
const forwarding = await loadForwardingConfig(configPath, process.env);
const paths = dataPaths(process.env, root);
// Visible proof of the root: without MASTRA_PROJECT_ROOT the paths fall back to the working
// directory (`.mastra/output` under `mastra start`'s layout).
console.log(`hex studio: data in ${paths.databasePath} and ${paths.observabilityPath}`);
const chatAgent = configPath ? createStudioChatAgent(await loadChatModel(configPath)) : undefined;

export const mastra = createHexMastra({
  storage: await createHexStore(paths),
  workflows: {
    [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({
      runtime: createIntakeRuntime(
        paths,
        dateExtractorLayer(model),
        forwarding && smtpMailerLayer(forwarding.smtp),
      ),
      category,
      forwarding,
    }),
  },
  agents: chatAgent && { [chatAgent.id]: chatAgent },
});
