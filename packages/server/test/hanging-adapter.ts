// A chat adapter that opens a DM at once but never confirms a post, as a platform that hangs.
import type { MainChannelTarget } from "../src/main-channel";

/** Only what the Main channel calls: `openDM` answers, `postMessage` never settles. */
export const hangingAdapter = () =>
  ({
    openDM: async () => "D0DANIEL",
    postMessage: () => new Promise<never>(() => {}),
  }) as unknown as MainChannelTarget["adapter"];
