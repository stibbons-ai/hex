import { expect, test } from "bun:test";
import { closeInOrder } from "../src/close";

test("runs every closer in order after failures and rethrows the first failure", async () => {
  const ran: string[] = [];
  const first = new Error("server stop failed");
  const promise = closeInOrder([
    async () => {
      ran.push("server");
      throw first;
    },
    async () => {
      ran.push("mastra");
      throw new Error("mastra shutdown failed");
    },
    async () => {
      ran.push("storage");
    },
  ]);
  await expect(promise).rejects.toBe(first);
  expect(ran).toEqual(["server", "mastra", "storage"]);
});

test("resolves when every closer succeeds", async () => {
  const ran: string[] = [];
  await closeInOrder([async () => ran.push("a"), async () => ran.push("b")]);
  expect(ran).toEqual(["a", "b"]);
});
