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

/**
 * A Message-ID header value without its RFC 5322 comments (`<a@b> (a comment)` → `a@b` once
 * normalised), each replaced by a space, for `normalizeMessageId` to trim. Comments nest, and
 * `\x` inside one is a quoted pair (`(a \) b)` is one comment). Parens inside angle brackets are
 * part of the id and stay. An unclosed comment runs to the end of the value; a stray `)` is plain
 * text. For a raw header value only, never a normalised key: without its brackets, parens inside
 * an id would count as a comment (`<a(b)c@d>` → `a(b)c@d` → `a c@d`).
 */
export function withoutMessageIdComments(value: string): string {
  // One pass with no backtracking: a sender controls the input.
  let result = "";
  let kept = 0;
  let inBrackets = false;
  let i = 0;
  while (i < value.length) {
    const char = value[i++];
    if (char === "<") inBrackets = true;
    else if (char === ">") inBrackets = false;
    else if (char === "(" && !inBrackets) {
      result += `${value.slice(kept, i - 1)} `;
      let depth = 1;
      while (depth > 0 && i < value.length) {
        const inner = value[i++];
        if (inner === "\\") i++;
        else if (inner === "(") depth++;
        else if (inner === ")") depth--;
      }
      kept = i;
    }
  }
  return result + value.slice(kept);
}

/** What `String.prototype.trim` removes. */
const WHITESPACE = /\s/;
