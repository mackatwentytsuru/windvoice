import { describe, expect, it } from 'vitest';
import { tryFastPath } from '../src/main/postprocess/fastPath';
import { SettingsSchema, type Settings } from '../src/shared/types';

function settings(patch: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse(patch);
}

function run(text: string, s: Settings = settings(), hasAppInstructions = false): string | null {
  return tryFastPath({ text, settings: s, hasAppInstructions });
}

describe('tryFastPath', () => {
  it('finishes a short clean Japanese take locally with 。', () => {
    expect(run('了解です')).toBe('了解です。');
  });

  it('keeps existing sentence-final punctuation', () => {
    expect(run('明日の会議は十時からです。')).toBe('明日の会議は十時からです。');
    expect(run('本当ですか？')).toBe('本当ですか？');
  });

  it('skips a longer take only when it already ends a sentence', () => {
    const long = '今日は午後から新しいプロジェクトの打ち合わせがあるので資料を準備しておいてください';
    expect(run(long)).toBeNull();
    expect(run(`${long}。`)).toBe(`${long}。`);
  });

  it('sends formatting commands, stutters and fillers to the model', () => {
    expect(run('改行')).toBeNull();
    expect(run('箇条書き りんご みかん')).toBeNull();
    expect(run('結結結こんにちは')).toBeNull();
    expect(run('えーと、了解です')).toBeNull();
    expect(run('あのー明日')).toBeNull();
  });

  it('defers to the model when custom or app instructions exist', () => {
    expect(run('了解です', settings({ formatter: { customInstructions: '敬語にする' } }))).toBeNull();
    expect(run('了解です', settings(), true)).toBeNull();
  });

  it('can be turned off', () => {
    expect(run('了解です', settings({ formatter: { fastPath: false } }))).toBeNull();
  });

  it('applies strict settings-dictionary replacements', () => {
    const s = settings({ dictionary: [{ from: 'ウインドボイス', to: 'WindVoice' }] });
    expect(run('ウインドボイスを起動', s)).toBe('WindVoiceを起動。');
  });

  it('capitalizes and terminates short English takes', () => {
    expect(run('sounds good', settings({ language: 'en' }))).toBe('Sounds good.');
  });

  it('does not touch multi-line text', () => {
    expect(run('一行目\n二行目')).toBeNull();
  });
});
