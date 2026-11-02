import { expect, test } from "bun:test";
import { closeInOrder } from "../src/close";

test("runs every closer in order after a failure and rethrows a single failure as is", async () => {
  const ran: string[] = [];
  const failure = new Error("server stop failed");
  const promise = closeInOrder([
    async () => {
      ran.push("server");
      throw failure;
    },
    async () => {
      ran.push("mastra");
    },
    async () => {
      ran.push("storage");
    },
  ]);
  await expect(promise).rejects.toBe(failure);
  expect(ran).toEqual(["server", "mastra", "storage"]);
});

test("rethrows several failures together as an AggregateError", async () => {
  const first = new Error("server stop failed");
  const second = new Error("mastra shutdown failed");
  const error = await closeInOrder([
    async () => {
      throw first;
    },
    async () => {
      throw second;
    },
    async () => {},
  ]).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([first, second]);
});

test("resolves when every closer succeeds", async () => {
  const ran: string[] = [];
  await closeInOrder([async () => ran.push("a"), async () => ran.push("b")]);
  expect(ran).toEqual(["a", "b"]);
});
