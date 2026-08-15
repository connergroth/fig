/**
 * Strip lone (unpaired) UTF-16 surrogates from a string.
 *
 * Why this exists: characters outside the BMP (emoji, some CJK) are encoded as a
 * surrogate PAIR — a high half (U+D800–DBFF) followed by a low half (U+DC00–DFFF).
 * When external text (a scraped page from the browser specialist, a fetched page,
 * a tool result) gets sliced by a fixed character/byte length, the cut can land
 * mid-pair and leave an orphaned half. A lone surrogate is not valid Unicode, so it
 * can't be encoded into a JSON string — which makes the ENTIRE API request body
 * invalid ("400 no low surrogate in string: char N") and the reply dies at encode,
 * before the model ever sees it. (Real case: a ~198k-char page payload from a browse job.)
 *
 * Fix: replace any unpaired surrogate with U+FFFD (the Unicode replacement char)
 * before the text enters my context. Well-formed pairs are left untouched, so real
 * emoji/CJK survive intact — only the orphaned halves get scrubbed.
 */
export function stripLoneSurrogates(s: string): string {
  if (!s) return s;
  return s
    // high surrogate NOT followed by a low surrogate
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "�")
    // low surrogate NOT preceded by a high surrogate
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}
