/**
 * Parses copied JSON, accepting Unicode whitespace introduced by rich-text clipboards.
 * Only whitespace outside strings is normalized; names, reasons and escaped quotes stay intact.
 * JSON.parse remains responsible for validating the actual JSON syntax.
 */
export function parsePastedJson(text: string): unknown {
  let inString = false;
  let escaped = false;
  const normalized: string[] = [];
  for (const character of text) {
    if (inString) {
      normalized.push(character);
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
      normalized.push(character);
    } else {
      normalized.push(/\s/u.test(character) ? ' ' : character);
    }
  }
  return JSON.parse(normalized.join('')) as unknown;
}
