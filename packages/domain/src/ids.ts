/** A mail header ID (Message-ID, Content-ID) trimmed, without its surrounding angle brackets. */
export function unbracket(id: string): string {
  return id
    .trim()
    .replace(/^<(.*)>$/s, "$1")
    .trim();
}
