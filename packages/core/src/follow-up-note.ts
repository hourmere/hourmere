/** The stored and rendered note limit, measured in JavaScript UTF-16 code units. */
export const FOLLOW_UP_HOST_NOTE_MAX_LENGTH = 2000

const FORBIDDEN_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove forbidden plain-text controls
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

/** Treat even legacy or untrusted stored notes as bounded plain text. */
export function normalizeFollowUpHostNote(text: string): string {
  return text
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(FORBIDDEN_CONTROLS, '')
    .slice(0, FOLLOW_UP_HOST_NOTE_MAX_LENGTH)
    .toWellFormed()
}
