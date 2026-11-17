/**
 * CSV helpers shared by every export button.
 *
 * `toCsv` builds RFC 4180 text (CRLF line endings) and guards against spreadsheet
 * formula injection; `downloadCsv` hands the text to the browser as a UTF-8 file
 * with a BOM so Excel reads accents correctly.
 */

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Converts one cell to its CSV text (before quoting).
 *
 * JS numbers and plain numeric strings are never prefixed, so negative amounts
 * stay numbers in the spreadsheet. Any other text that starts with a formula
 * trigger character gets a leading single quote.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  const text = String(value);
  if (PLAIN_NUMBER.test(text)) {
    return text;
  }
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function quoteCell(value: unknown): string {
  const text = cellText(value);
  return /["\r\n,;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serializes a header row and data rows to CSV text.
 *
 * Pass an empty `headers` array to emit only the data rows (for sectioned exports).
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(quoteCell).join(','));
  }
  for (const row of rows) {
    lines.push(row.map(quoteCell).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Starts a browser download of `csv` as `filename`. No-op outside the browser.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke after the click has been handled, or some browsers cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
