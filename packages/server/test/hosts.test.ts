import { expect, test } from "bun:test";
import { allowedHosts } from "../src/hosts";

test("a 127.0.0.1 bind allows exactly the loopback names with the bound port", () => {
  expect([...allowedHosts(4111, "127.0.0.1")]).toEqual(["127.0.0.1:4111", "localhost:4111"]);
});

test("on port 80 also allows the names without a port", () => {
  expect([...allowedHosts(80, "127.0.0.1")]).toEqual([
    "127.0.0.1:80",
    "localhost:80",
    "127.0.0.1",
    "localhost",
  ]);
});

test("a wildcard bind (the container's) still allows only the loopback names", () => {
  expect([...allowedHosts(4111, "0.0.0.0")]).toEqual(["127.0.0.1:4111", "localhost:4111"]);
  expect([...allowedHosts(4111, "::")]).toEqual(["127.0.0.1:4111", "localhost:4111"]);
});

test("a specific bind address is allowed too, IPv6 in brackets", () => {
  expect([...allowedHosts(4111, "192.168.1.20")]).toEqual([
    "127.0.0.1:4111",
    "localhost:4111",
    "192.168.1.20:4111",
  ]);
  expect([...allowedHosts(4111, "::1")]).toEqual([
    "127.0.0.1:4111",
    "localhost:4111",
    "[::1]:4111",
  ]);
});
