/** Sender IDs allowed to talk to hex, per channel (platform key such as `slack`). */
export type ChannelAllowlists = Readonly<Record<string, readonly string[]>>;

export type SenderDecision = "allow" | "deny";

/**
 * Deny by default: a sender is allowed only when its channel has an entry listing the exact
 * sender ID (no trimming, no case folding). An unknown channel, an empty list or an empty sender
 * ID is denied.
 */
export function decideSender(
  allowlists: ChannelAllowlists,
  channel: string,
  sender: string | undefined,
): SenderDecision {
  if (!sender || !Object.hasOwn(allowlists, channel)) return "deny";
  return allowlists[channel]?.includes(sender) ? "allow" : "deny";
}
