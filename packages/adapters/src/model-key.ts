import { getProviderConfig } from "@mastra/core/llm";
import type { MastraModelConfig } from "@mastra/core/llm";

/**
 * `model` with its API key from `HEX_<variable>`, where `<variable>` is one of the variables
 * Mastra's model router reads for the model's provider (e.g. `HEX_ANTHROPIC_API_KEY` for an
 * `anthropic/` model, `HEX_GOOGLE_API_KEY` for a `google/` one). The prefix keeps hex's keys out
 * of the provider's own variable, which coding agents started from the development shell would
 * otherwise pick up and bill instead of their subscription. Unchanged when no such variable is set
 * (an empty value counts as unset) or `model` is no router id: the router then reads the
 * provider's own variable, so a missing key fails on the model call, naming that variable.
 */
export function withHexApiKey(
  model: MastraModelConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MastraModelConfig {
  if (typeof model !== "string") return model;
  const [provider = ""] = model.split("/", 1);
  const variables = getProviderConfig(provider)?.apiKeyEnvVar ?? [];
  for (const variable of typeof variables === "string" ? [variables] : variables) {
    const apiKey = env[`HEX_${variable}`];
    if (apiKey) return { id: model as `${string}/${string}`, apiKey };
  }
  return model;
}
