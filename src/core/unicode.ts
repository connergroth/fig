/**
 * Replace unpaired UTF-16 surrogates with U+FFFD while preserving valid surrogate
 * pairs. JavaScript strings can contain lone surrogates, but Claude's request JSON
 * parser rejects them ("no low surrogate in string"). iMessage can produce one when
 * it truncates quoted reaction text between the two code units of an emoji.
 */
export function toWellFormedUnicode(value: string): string {
  let out = "";
  let changed = false;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      } else {
        out += "\ufffd";
        changed = true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
      changed = true;
    } else {
      out += value[i];
    }
  }

  return changed ? out : value;
}

/** Normalize every segment of a cache-boundary system prompt. */
export function toWellFormedUnicodeList(value: string[]): string[] {
  return value.map(toWellFormedUnicode);
}

/** Truncate by Unicode code points, never between an emoji's surrogate pair. */
export function truncateUnicode(value: string, maxCodePoints: number): string {
  return Array.from(toWellFormedUnicode(value)).slice(0, maxCodePoints).join("");
}
