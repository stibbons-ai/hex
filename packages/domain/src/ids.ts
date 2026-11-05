/**
 * The key an Intake is processed once by: its Message-ID trimmed, without surrounding angle
 * brackets. Empty when the Message-ID is blank. Content-IDs are compared the same way (see
 * `normalizeContentId`).
 */
export function normalizeMessageId(messageId: string): string {
  return messageId
    .trim()
    .replace(/^<(.*)>$/s, "$1")
    .trim();
}
