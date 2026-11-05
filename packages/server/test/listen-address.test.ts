import { describe, expect, test } from "bun:test";
import { listenAddress } from "../src/listen-address";

describe("listenAddress", () => {
  test("defaults to 127.0.0.1:4111; empty values count as unset; HOST and PORT never apply", () => {
    expect(listenAddress({})).toEqual({ hostname: "127.0.0.1", port: 4111 });
    expect(listenAddress({ HEX_HOST: "", HEX_PORT: "", HOST: "0.0.0.0", PORT: "80" })).toEqual({
      hostname: "127.0.0.1",
      port: 4111,
    });
  });

  test.each([
    ["0.0.0.0", "0"],
    ["::", "65535"],
    ["::1", "4111"],
    ["192.168.1.20", "8080"],
  ])("takes HEX_HOST=%j and HEX_PORT=%j", (host, port) => {
    expect(listenAddress({ HEX_HOST: host, HEX_PORT: port })).toEqual({
      hostname: host,
      port: Number(port),
    });
  });

  test.each([
    ["0:0:0:0:0:0:0:1", "::1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["::FFFF:127.0.0.1", "::ffff:7f00:1"],
  ])("normalises HEX_HOST=%j to %j, the form clients send", (host, normal) => {
    expect(listenAddress({ HEX_HOST: host }).hostname).toBe(normal);
  });

  test.each(["localhost", "example.com", "0.0.0.0:4111", "[::1]", " 127.0.0.1", "fe80::1%en0"])(
    "rejects HEX_HOST=%j: an IP address only, never a name",
    (host) => {
      expect(() => listenAddress({ HEX_HOST: host })).toThrow(
        `HEX_HOST must be an IP address (127.0.0.1, or 0.0.0.0 inside a container), got ${JSON.stringify(host)}`,
      );
    },
  );
});
