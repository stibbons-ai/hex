/** Sender IDs allowed to talk to hex, per platform key such as `slack`. */
export type ChannelAllowlists = Readonly<Record<string, readonly string[]>>;

export type SenderDecision = "allow" | "deny";

/**
 * Deny by default: a sender is allowed only when its platform has an entry listing the exact
 * sender ID (no trimming, no case folding). An unknown platform, an empty list or an empty sender
 * ID is denied.
 */
export function decideSender(
  allowlists: ChannelAllowlists,
  platform: string,
  sender: string | undefined,
): SenderDecision {
  if (!sender || !Object.hasOwn(allowlists, platform)) return "deny";
  return allowlists[platform]?.includes(sender) ? "allow" : "deny";
}
