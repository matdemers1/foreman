/**
 * Plain text out of a string that may carry markdown.
 *
 * Titles imported from the vault are markdown source — `**Golden corpus + OCR accuracy report**`,
 * `~~Cloud replication~~ · **Promoted to [[Phase 13]]**`. Rendering that verbatim in a one-line row
 * shows the asterisks, and rendering it *as* markdown in a table cell brings block elements into a
 * row that is one line tall.
 *
 * So: strip the syntax for compact contexts, and leave the stored value alone. The document body
 * is still rendered as markdown where it belongs — this is only for a title in a list.
 *
 * Deliberately small. A full parse would pull a library in to make a heading shorter, and the
 * cases that actually occur in the corpus are these five.
 */
export function plainText(input: string): string {
  return input
    // `[[Vault/Path|Label]]` and `[[Label]]` — the label is what a reader wants.
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
    // `[label](href)`
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Emphasis, strong, strikethrough and code, in any nesting.
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)\*(\S)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
