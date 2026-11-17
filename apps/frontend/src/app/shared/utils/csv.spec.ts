import { describe, expect, it } from 'vitest';

import { toCsv } from './csv';

describe('toCsv', () => {
  it('joins headers and rows with commas and CRLF line endings', () => {
    expect(toCsv(['name', 'amount'], [['alice', 10]])).toBe('name,amount\r\nalice,10');
  });

  it('quotes cells containing comma, semicolon, quote, or newline and doubles quotes', () => {
    const csv = toCsv(['a'], [['x,y'], ['p;q'], ['say "hi"'], ['line1\nline2']]);
    expect(csv).toBe('a\r\n"x,y"\r\n"p;q"\r\n"say ""hi"""\r\n"line1\nline2"');
  });

  it('prefixes formula-like text with a single quote', () => {
    const csv = toCsv(
      ['x'],
      [['=SUM(A1)'], ['+1+1'], ['-cmd'], ['@user'], ['\tcell'], ['\rcell']],
    );
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe("'=SUM(A1)");
    expect(lines[2]).toBe("'+1+1");
    expect(lines[3]).toBe("'-cmd");
    expect(lines[4]).toBe("'@user");
    expect(lines[5]).toBe("'\tcell");
    expect(lines[6]).toBe("\"'\rcell\"");
  });

  it('keeps negative amounts as numbers, both as JS numbers and numeric strings', () => {
    expect(toCsv([], [[-1500, '-42.5', '3.14']])).toBe('-1500,-42.5,3.14');
  });

  it('renders null and undefined cells as empty', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, undefined, 'x']])).toBe('a,b,c\r\n,,x');
  });

  it('omits the header line when no headers are given', () => {
    expect(toCsv([], [['Title'], [], ['1', '2']])).toBe('Title\r\n\r\n1,2');
  });
});
