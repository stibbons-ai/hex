import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { IntakeLedger, intakeLedgerLayer } from "../src";

let directory: string;
let databases = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-ledger-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const freshDatabase = () => join(directory, `db-${databases++}`, "mastra.db");

/** Runs `program` against the ledger in `databasePath`, opened and closed around it. */
const withLedger = <A, E>(
  databasePath: string,
  program: (ledger: IntakeLedger["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    IntakeLedger.use(program).pipe(Effect.provide(intakeLedgerLayer(databasePath))),
  );

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

describe("IntakeLedger", () => {
  test("an unknown Intake is not processed; a recorded one is, across connections", async () => {
    const databasePath = freshDatabase();
    expect(success(await withLedger(databasePath, (ledger) => ledger.find("<a@x>")))).toBe(
      undefined,
    );
    success(
      await withLedger(databasePath, (ledger) =>
        ledger.record("<a@x>", { documentCount: 2, filings: [{ path: "2026-11/ER/a.pdf" }] }),
      ),
    );
    const entry = success(await withLedger(databasePath, (ledger) => ledger.find("<a@x>")));
    expect(entry).toMatchObject({
      messageId: "a@x",
      documentCount: 2,
      filings: [{ path: "2026-11/ER/a.pdf" }],
    });
    expect(Number.isNaN(Date.parse(entry!.processedAt))).toBe(false);
  });

  test("the Message-ID is normalised: brackets and whitespace don't make a new Intake", async () => {
    const databasePath = freshDatabase();
    success(
      await withLedger(databasePath, (ledger) =>
        ledger.record(" <b@x> ", { documentCount: 0, filings: [] }),
      ),
    );
    for (const form of ["b@x", "<b@x>", "  b@x"]) {
      const entry = success(await withLedger(databasePath, (ledger) => ledger.find(form)));
      expect(entry).toMatchObject({ messageId: "b@x", documentCount: 0, filings: [] });
    }
  });

  test("recording an Intake twice fails instead of replacing the first entry", async () => {
    const databasePath = freshDatabase();
    success(
      await withLedger(databasePath, (ledger) =>
        ledger.record("c@x", { documentCount: 1, filings: [{ path: "2026-11/ER/c.pdf" }] }),
      ),
    );
    const again = await withLedger(databasePath, (ledger) =>
      ledger.record("<c@x>", { documentCount: 0, filings: [] }),
    );
    expect(Exit.isFailure(again)).toBe(true);
    expect(String(again)).toContain("Intake ledger: recording c@x");
    expect(success(await withLedger(databasePath, (ledger) => ledger.find("c@x")))).toMatchObject({
      documentCount: 1,
    });
  });

  test("a blank Message-ID is an error", async () => {
    const exit = await withLedger(freshDatabase(), (ledger) => ledger.find(" <> "));
    expect(String(exit)).toContain("blank Message-ID");
  });
});
