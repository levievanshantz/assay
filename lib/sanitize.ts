/**
 * Sanitizes proposal input text before it reaches the evaluation pipeline.
 * Strips invisible/control characters that would corrupt LLM prompts or DB writes.
 * Visible Unicode (smart quotes, em dashes, accented chars, CJK, etc.) passes through unchanged.
 */
export function sanitizeInput(raw: string): string {
  return raw
    .replace(/\0/g, "")                                      // null bytes
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")             // zero-width chars + BOM
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "") // bidi control marks
    .replace(/\r\n/g, "\n")                                  // normalize CRLF
    .replace(/\r/g, "\n")                                    // normalize bare CR
    .replace(/\u00A0/g, " ")                                 // non-breaking space → space
    .replace(/\n{3,}/g, "\n\n")                              // collapse excessive blank lines
    .trim();
}
