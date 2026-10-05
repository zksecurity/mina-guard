// Bundle text is untrusted. A terminal acts on control characters instead of
// printing them, so a memo or type string could move the cursor, clear the
// screen or reorder text. Escaping them keeps every byte visible.
const TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Replaces control, format (including bidi) and line-separator characters with visible `\u{XX}` text. */
export function escapeTerminalText(input: string): string {
  return input.replace(TERMINAL_UNSAFE, (character) =>
    `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`);
}

/** Escapes multi-line text line by line, keeping the line breaks the caller wrote. */
export function escapeTerminalLines(text: string): string {
  return text.split('\n').map(escapeTerminalText).join('\n');
}
