// LiteLLM's price data on loopback, for `HEX_EVAL_PRICES_URL`: answers every GET with `body`
// (JSON-encoded unless a string) and the status, counting the requests.
import type { Server } from "bun";

export interface FakePrices {
  server: Server<undefined>;
  /** `http://127.0.0.1:<port>/model_prices_and_context_window.json`. */
  url: string;
  /** How many times the price data was fetched. */
  readonly fetches: number;
}

export function fakePrices(body: unknown, status = 200): FakePrices {
  let fetches = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      fetches++;
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}/model_prices_and_context_window.json`,
    get fetches() {
      return fetches;
    },
  };
}
