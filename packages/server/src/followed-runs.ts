// Intake runs the mailbox watcher follows: it started them and awaits their outcome, which it
// logs itself. Shared on the Intake runtime, so the Intake workflow's move step can tell.
import { Context, Layer } from "effect";

/**
 * The ids of the Intake runs the mailbox watcher in this process started and awaits; it logs a
 * failed one's outcome itself (`hex: Intake <id>: the run failed: <reason>`). Written by the
 * watcher alone; empty after a restart, so a run resumed at boot is not followed.
 */
export class FollowedRuns extends Context.Service<FollowedRuns, Set<string>>()(
  "hex/FollowedRuns",
) {}

/** No run followed yet: one set per Intake runtime. */
export const followedRunsLayer = Layer.sync(FollowedRuns, () => new Set<string>());
