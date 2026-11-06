// Intakes held back in memory: failed runs the ledger couldn't count, counted by the mailbox
// watcher instead. Shared on the Intake runtime, so the Intake workflow's report counts them too.
import { Context, Layer } from "effect";

/** An Intake's failed runs the ledger couldn't count: how many, and when the last one failed. */
export interface HeldBackRuns {
  readonly count: number;
  readonly lastAt: number;
}

/**
 * The Intakes held back in memory, by Message-ID (normalised). An Intake's effective failed runs,
 * the ones the mailbox watcher decides by, are the ledger's plus its `count` here. Written by the
 * watcher alone; lost when hex restarts.
 */
export class HeldBack extends Context.Service<HeldBack, Map<string, HeldBackRuns>>()(
  "hex/HeldBack",
) {}

/** Nothing held back yet: one map per Intake runtime. */
export const heldBackLayer = Layer.sync(HeldBack, () => new Map<string, HeldBackRuns>());
