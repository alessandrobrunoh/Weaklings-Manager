import { describe, expect, it } from 'vitest';

import { parsePastedJson } from './pasted-json';

describe('parsePastedJson', () => {
  it('accepts non-breaking indentation from the pasted Albion export', () => {
    const text = '[\n\u00a0 {\n\u00a0\u00a0 "Date": "2026-11-16 23:10:00",\n'
      + '\u00a0\u00a0 "Player": "Galvdon",\n\u00a0\u00a0 "Reason": "Withdrawal",\n'
      + '\u00a0\u00a0 "Amount": "-7414881"\n\u00a0 }\n]';
    expect(() => JSON.parse(text)).toThrow();
    expect(parsePastedJson(text)).toEqual([{
      Date: '2026-11-16 23:10:00',
      Player: 'Galvdon',
      Reason: 'Withdrawal',
      Amount: '-7414881',
    }]);
  });

  it('accepts BOMs and narrow non-breaking spaces outside strings', () => {
    expect(parsePastedJson('\uFEFF[\u202f{"Amount": 6400000}\u202f]'))
      .toEqual([{ Amount: 6400000 }]);
  });

  it('preserves string contents, escaped quotes and backslashes', () => {
    const row = { Player: 'A\u00a0B', Reason: 'A "quoted"\u202fvalue\\', Amount: '-1' };
    expect(parsePastedJson(`[\u00a0${JSON.stringify(row)}]`)).toEqual([row]);
  });

  it('keeps legitimate identical rows', () => {
    expect(parsePastedJson('[\u00a0{"Amount":"-1"},\u00a0{"Amount":"-1"}]'))
      .toHaveLength(2);
  });

  it('still rejects malformed syntax and whitespace inside numbers', () => {
    expect(() => parsePastedJson('[{"Amount":1},]')).toThrow();
    expect(() => parsePastedJson('[1\u00a02]')).toThrow();
    expect(() => parsePastedJson('[{"Player":"unfinished}]')).toThrow();
  });
});
