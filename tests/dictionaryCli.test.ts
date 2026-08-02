import { describe, expect, it } from 'vitest';
import { CorrectionCliError, parseAddCorrectionArgs } from '../src/main/dictionary/cli';

describe('--add-correction CLI', () => {
  it('parses 誤変換=正しい語 while preserving additional equals in the canonical value', () => {
    expect(parseAddCorrectionArgs(['windvoice', '--add-correction', '誤変換=正しい=語'])).toEqual({
      variant: '誤変換',
      correct: '正しい=語'
    });
  });

  it('returns null when the flag is absent', () => {
    expect(parseAddCorrectionArgs(['windvoice'])).toBeNull();
  });

  it.each([
    ['missing value', ['windvoice', '--add-correction']],
    ['missing separator', ['windvoice', '--add-correction', 'wrong']],
    ['empty variant', ['windvoice', '--add-correction', '=right']],
    ['empty correct value', ['windvoice', '--add-correction', 'wrong=']],
    ['control character', ['windvoice', '--add-correction', 'bad\nvalue=right']]
  ])('rejects %s', (_label, argv) => {
    expect(() => parseAddCorrectionArgs(argv)).toThrow(CorrectionCliError);
  });

  it('rejects duplicate flags instead of silently choosing one', () => {
    expect(() =>
      parseAddCorrectionArgs([
        'windvoice',
        '--add-correction',
        'one=一',
        '--add-correction',
        'two=二'
      ])
    ).toThrow(CorrectionCliError);
  });
});
