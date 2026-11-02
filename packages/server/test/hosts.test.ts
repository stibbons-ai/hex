import { expect, test } from "bun:test";
import { allowedHosts } from "../src/hosts";

test("allows exactly the loopback names with the bound port", () => {
  expect([...allowedHosts(4111)]).toEqual(["127.0.0.1:4111", "localhost:4111"]);
});

test("on port 80 also allows the names without a port", () => {
  expect([...allowedHosts(80)]).toEqual(["127.0.0.1:80", "localhost:80", "127.0.0.1", "localhost"]);
});
