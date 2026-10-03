import { describe, expect, it } from 'vitest';
import { isSilenceHallucination } from '../src/main/postprocess/hallucination';

describe('isSilenceHallucination', () => {
  it('matches whole-take stock outro phrases', () => {
    expect(isSilenceHallucination('ご視聴ありがとうございました。')).toBe(true);
    expect(isSilenceHallucination(' チャンネル登録よろしくお願いします！')).toBe(true);
    expect(isSilenceHallucination('Thanks for watching!')).toBe(true);
  });

  it('leaves real dictation that merely contains a phrase alone', () => {
    expect(isSilenceHallucination('昨日の配信、ご視聴ありがとうございましたと伝えて')).toBe(false);
    expect(isSilenceHallucination('ありがとうございました')).toBe(false);
    expect(isSilenceHallucination('')).toBe(false);
  });
});
