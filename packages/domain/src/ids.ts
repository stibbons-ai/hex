/**
 * The key an Intake is processed once by: its Message-ID trimmed, without surrounding angle
 * brackets, however many layers (`<<a@b>>` → `a@b`), so a key normalises to itself. Empty when
 * the Message-ID is blank, brackets aside. Content-IDs are compared this way and also lowercased
 * (see `normalizeContentId`).
 */
export function normalizeMessageId(messageId: string): string {
  let key = messageId.trim();
  for (let unwrapped = unwrap(key); unwrapped !== key; unwrapped = unwrap(key)) key = unwrapped;
  return key;
}

/** `id` without one layer of surrounding angle brackets, trimmed. */
const unwrap = (id: string) => id.replace(/^<(.*)>$/s, "$1").trim();
