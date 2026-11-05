// A fake OpenAI Responses API on loopback, for the model router's `openai/…` models: point
// `OPENAI_BASE_URL` at `baseUrl` and set any `OPENAI_API_KEY`.
import type { Server } from "bun";

/** One `POST /v1/responses` as the fake received it. */
export interface ResponsesRequest {
  model: string;
  input: { role: string; content: string | Record<string, unknown>[] }[];
}

/** How the fake answers: the model's text, or an HTTP error with OpenAI's error body. */
export type FakeAnswer = string | { status: number; message: string };

export interface FakeOpenAI {
  server: Server<undefined>;
  /** `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  /** Every request, in order. */
  requests: ResponsesRequest[];
}

/** The `input_file` parts of a request: their data URLs. */
export function inputFiles(request: ResponsesRequest): string[] {
  return request.input.flatMap(({ content }) =>
    typeof content === "string"
      ? []
      : content.flatMap((part) =>
          part["type"] === "input_file" ? [String(part["file_data"])] : [],
        ),
  );
}

/** A fake that answers each request with `answer(request)`. */
export function fakeOpenAI(answer: (request: ResponsesRequest) => FakeAnswer): FakeOpenAI {
  const requests: ResponsesRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as ResponsesRequest;
      requests.push(body);
      const reply = answer(body);
      if (typeof reply !== "string") {
        return Response.json(
          { error: { message: reply.message, type: "invalid_request_error", code: null } },
          { status: reply.status },
        );
      }
      return Response.json({
        id: `resp_${requests.length}`,
        object: "response",
        created_at: 1_793_882_952,
        model: body.model,
        status: "completed",
        output: [
          {
            type: "message",
            id: `msg_${requests.length}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: reply, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}/v1`, requests };
}
