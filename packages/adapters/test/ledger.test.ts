import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { IntakeLedger, intakeLedgerLayer } from "../src";
import { localDatabaseUrl } from "../src/storage";

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
    const filings = [
      { index: 1, path: "2026-11/ER/a.pdf", fellBack: true },
      { index: 2, path: "2026-09/ER/b.pdf", fellBack: false },
    ];
    success(
      await withLedger(databasePath, (ledger) =>
        TestClock.setTime(Date.UTC(2026, 10, 5, 12, 30)).pipe(
          Effect.andThen(ledger.record("<a@x>", filings)),
          Effect.provide(TestClock.layer()),
        ),
      ),
    );
    expect(success(await withLedger(databasePath, (ledger) => ledger.find("<a@x>")))).toEqual({
      messageId: "a@x",
      processedAt: "2026-11-05T12:30:00.000Z",
      documentCount: 2,
      filings,
    });
  });

  test("the Message-ID is normalised: brackets and whitespace don't make a new Intake", async () => {
    const databasePath = freshDatabase();
    success(await withLedger(databasePath, (ledger) => ledger.record(" <b@x> ", [])));
    for (const form of ["b@x", "<b@x>", "  b@x"]) {
      const entry = success(await withLedger(databasePath, (ledger) => ledger.find(form)));
      expect(entry).toMatchObject({ messageId: "b@x", documentCount: 0, filings: [] });
    }
  });

  test("recording an Intake twice fails instead of replacing the first entry", async () => {
    const databasePath = freshDatabase();
    success(
      await withLedger(databasePath, (ledger) =>
        ledger.record("c@x", [{ index: 0, path: "2026-11/ER/c.pdf" }]),
      ),
    );
    const again = await withLedger(databasePath, (ledger) => ledger.record("<c@x>", []));
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

  test("an entry recorded before Document dates were read still reads back, flag absent", async () => {
    const databasePath = freshDatabase();
    success(await withLedger(databasePath, (ledger) => ledger.find("<new@x>")));
    const client = createClient({ url: await localDatabaseUrl(databasePath) });
    try {
      await client.execute({
        sql: "INSERT INTO hex_intake_ledger (message_id, processed_at, document_count, filings) VALUES (?, ?, ?, ?)",
        args: ["old@x", "2026-10-01T08:00:00.000Z", 1, '[{"index":0,"path":"2026-10/ER/a.pdf"}]'],
      });
    } finally {
      client.close();
    }
    const entry = success(await withLedger(databasePath, (ledger) => ledger.find("old@x")));
    expect(entry?.filings).toEqual([{ index: 0, path: "2026-10/ER/a.pdf" }]);
    expect(entry?.filings[0]).not.toHaveProperty("fellBack");
  });
});
