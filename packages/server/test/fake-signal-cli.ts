// A fake signal-cli HTTP daemon (`signal-cli daemon --http`, the 0.14.9 wire protocol) on
// loopback: JSON-RPC on `POST /api/v1/rpc`, receive events as server-sent events on
// `GET /api/v1/events`, health on `GET /api/v1/check`. Never reaches Signal.
import type { Server } from "bun";
import { within } from "./timeouts";

// Placeholders, never real numbers (+1 555-555-01xx is reserved for fiction) or real ACIs.
export const BOT_ACCOUNT = "+15555550100";
export const BOT_ACI = "00000000-0000-4000-8000-000000000001";
/** Daniel's ACI, as the allowlist names him; the adapter keys senders by ACI. */
export const DANIEL = "d0d0d0d0-0000-4000-8000-00000000da11";

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
  /** The JSON-RPC error code the fake answered with, if it answered with an error. */
  error?: number;
}

export interface FakeSignalCliOptions {
  /** Accounts the daemon serves; default: the bot account. */
  accounts?: { number: string; uuid: string }[];
  /**
   * Act like a daemon started with `-a <account>`: `listAccounts` is not implemented, and
   * `listContacts` finds the account itself (signal-cli 0.14.9).
   */
  singleAccount?: boolean;
  /** `/api/v1/check` answers only once this settles (a slow daemon). */
  checkHold?: Promise<void>;
  /** The event stream opens (sends its headers) only once this settles. */
  eventsHold?: Promise<void>;
  /** Drop every event-stream connection before its response headers, as a crashing daemon would. */
  eventsReset?: boolean;
}

/** A Groups v2 ID (32 bytes) in standard base64, as signal-cli prints it. */
export const GROUP_ID = Buffer.alloc(32, 7).toString("base64");

export interface FakeSignalCli {
  server: Server<undefined>;
  url: string;
  /** Request paths (without query), in order. */
  paths: string[];
  /** JSON-RPC calls, in order. */
  calls: RpcCall[];
  /**
   * Sends one receive event, a text message, to every open event stream: 1:1, or in the Group
   * {@link GROUP_ID} with `group`, there with a native @mention of the bot when `mention` is set.
   */
  receive(message: {
    aci: string;
    text: string;
    number?: string;
    group?: { mention: boolean };
  }): void;
  /** Open event streams right now. */
  openStreams(): number;
  /** Event streams opened so far, closed ones included. */
  streamsOpenedEver(): number;
  /** Resolves once an event stream has been opened (it may be closed again by then). */
  streamOpened(): Promise<void>;
  /** Resolves once no event stream is open, the client having closed them all. */
  streamsClosed(): Promise<void>;
  /** Resolves with the first `count` `send` calls. Every wait here gives up after 2 s. */
  sends(count: number): Promise<RpcCall[]>;
  stop(): Promise<void>;
}

export function fakeSignalCli({
  accounts = [{ number: BOT_ACCOUNT, uuid: BOT_ACI }],
  singleAccount = false,
  checkHold,
  eventsHold,
  eventsReset = false,
}: FakeSignalCliOptions = {}): FakeSignalCli {
  const paths: string[] = [];
  const calls: RpcCall[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let opened = 0;
  let eventId = 0;
  let sendTimestamp = 1_700_000_000_000;
  let receiveTimestamp = 1_700_000_100_000;
  // Re-checked on every new call and every stream opened or closed.
  let waiters: (() => void)[] = [];
  const changed = () => {
    for (const check of waiters) check();
  };
  const until = async (condition: () => boolean, what: string) => {
    const met = Promise.withResolvers<void>();
    const check = () => {
      if (condition()) met.resolve();
    };
    waiters.push(check);
    check();
    try {
      await within(met.promise, what);
    } finally {
      waiters = waiters.filter((waiter) => waiter !== check);
    }
  };

  const result = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "version":
        return { version: "0.14.9" };
      case "listAccounts":
        return singleAccount ? undefined : accounts;
      case "listContacts": {
        // Only the daemon's own accounts are known contacts here.
        const wanted = (params["recipient"] as string[] | undefined) ?? [];
        return accounts
          .filter(({ number, uuid }) => wanted.includes(number) || wanted.includes(uuid))
          .map(({ number, uuid }) => ({ number, uuid, username: null, name: "" }));
      }
      case "listGroups":
        return [{ id: GROUP_ID, name: "Family", isMember: true, members: [] }];
      case "send":
      case "sendTyping":
      case "sendReceipt":
        return { timestamp: sendTimestamp++, results: [{ type: "SUCCESS" }] };
      default:
        return undefined;
    }
  };

  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The event stream stays open with no data; Bun's default 10 s idle timeout would cut it.
    idleTimeout: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      paths.push(pathname);
      if (pathname === "/api/v1/check" && request.method === "GET") {
        await checkHold;
        return new Response(null, { status: 200 });
      }
      if (pathname === "/api/v1/events" && request.method === "GET") {
        await eventsHold;
        let self: ReadableStreamDefaultController<Uint8Array>;
        const close = () => {
          streams.delete(self);
          changed();
        };
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            if (eventsReset) {
              controller.error(new Error("fake signal-cli dropped the connection"));
              return;
            }
            // Bun sends the headers with the first chunk; signal-cli sends them at once. A comment
            // line (as signal-cli's keep-alive) gets them out without an event.
            controller.enqueue(encoder.encode(":\n\n"));
            streams.add(controller);
            opened++;
            changed();
          },
          cancel: close,
        });
        request.signal.addEventListener("abort", close);
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (pathname === "/api/v1/rpc" && request.method === "POST") {
        const {
          id,
          method,
          params = {},
        } = (await request.json()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        const value = result(method, params);
        calls.push(value === undefined ? { method, params, error: -32601 } : { method, params });
        changed();
        return Response.json(
          value === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not implemented" } }
            : { jsonrpc: "2.0", id, result: value },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  const sendCalls = () => calls.filter((call) => call.method === "send");
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    paths,
    calls,
    streamsOpenedEver: () => opened,
    receive({ aci, text, number, group }) {
      const timestamp = receiveTimestamp++;
      // A text envelope as signal-cli 0.14.9 emits it (`JsonMessageEnvelope`): a mention is
      // U+FFFC in the text plus a `mentions` entry.
      const groupFields = group && {
        groupInfo: { groupId: GROUP_ID, groupName: "Family", revision: 3, type: "DELIVER" },
        ...(group.mention && {
          mentions: [{ name: BOT_ACI, number: null, uuid: BOT_ACI, start: 0, length: 1 }],
        }),
      };
      const envelope = {
        source: number ?? aci,
        sourceNumber: number ?? null,
        sourceUuid: aci,
        sourceName: null,
        sourceDevice: 1,
        timestamp,
        serverReceivedTimestamp: timestamp + 50,
        serverDeliveredTimestamp: timestamp + 60,
        dataMessage: {
          timestamp,
          message: group?.mention ? `\uFFFC ${text}` : text,
          expiresInSeconds: 0,
          viewOnce: false,
          ...groupFields,
        },
      };
      const data = JSON.stringify({ account: BOT_ACCOUNT, envelope });
      const event = encoder.encode(`id:run-${++eventId}\nevent:receive\ndata:${data}\n\n`);
      for (const stream of streams) stream.enqueue(event);
    },
    openStreams: () => streams.size,
    streamOpened: () => until(() => opened > 0, "the Signal event stream to open"),
    streamsClosed: () => until(() => streams.size === 0, "the Signal event streams to close"),
    async sends(count) {
      await until(() => sendCalls().length >= count, `${count} signal-cli send call(s)`);
      return sendCalls().slice(0, count);
    },
    async stop() {
      for (const stream of streams) stream.close();
      streams.clear();
      await server.stop(true);
    },
  };
}
