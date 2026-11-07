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
 * `\x` inside one is a quoted pair (`(a \) b)` is one comment). Everything inside angle brackets
 * is part of the id and stays, parens included; there a quoted string (`"…"`) or a domain literal
 * (`[…]`) runs to its unescaped closing `"` or `]`, `\x` inside it being a quoted pair, and a `>`
 * in it doesn't close the brackets (`<a@[x>(y)]>` → `a@[x>(y)]`). An unclosed quoted string or
 * domain literal keeps the rest of the value as it is. An unclosed comment runs to the end of the
 * value; a stray `)` is plain text. For a raw header value only, never a normalised key: without
 * its brackets, parens inside an id would count as a comment (`<a(b)c@d>` → `a(b)c@d` → `a c@d`).
 */
export function withoutMessageIdComments(value: string): string {
  // One pass with no backtracking: a sender controls the input.
  let result = "";
  let kept = 0;
  let inBrackets = false;
  // The `"` or `]` that ends the quoted string or domain literal being read inside the brackets.
  let closer = "";
  let i = 0;
  while (i < value.length) {
    const char = value[i++];
    if (closer) {
      if (char === "\\") i++;
      else if (char === closer) closer = "";
    } else if (char === "<") inBrackets = true;
    else if (inBrackets) {
      if (char === ">") inBrackets = false;
      else if (char === '"') closer = '"';
      else if (char === "[") closer = "]";
    } else if (char === "(") {
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
