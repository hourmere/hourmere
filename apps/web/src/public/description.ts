/** Drops blank lines so a three-line clamp never spends its last visible line on empty space. */
export function collapseBlankLines(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .filter((line) => line.trim().length > 0)
    .join('\n')
}
