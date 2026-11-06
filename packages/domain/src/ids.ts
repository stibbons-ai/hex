/**
 * The key an Intake is processed once by: its Message-ID trimmed, without surrounding angle
 * brackets, however many layers (`<<a@b>>` → `a@b`), so a key normalises to itself. Empty when
 * the Message-ID is blank, brackets aside. Content-IDs are compared this way and also lowercased
 * (see `normalizeContentId`).
 */
export function normalizeMessageId(messageId: string): string {
  // One pass inward from both ends: a sender controls the input, so no copy per layer.
  let start = 0;
  let end = messageId.length;
  const skipWhitespace = () => {
    while (start < end && WHITESPACE.test(messageId[start]!)) start++;
    while (end > start && WHITESPACE.test(messageId[end - 1]!)) end--;
  };
  skipWhitespace();
  while (end - start >= 2 && messageId[start] === "<" && messageId[end - 1] === ">") {
    start++;
    end--;
    skipWhitespace();
  }
  return messageId.slice(start, end);
}

/** What `String.prototype.trim` removes. */
const WHITESPACE = /\s/;
