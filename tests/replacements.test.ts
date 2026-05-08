import { describe, expect, it } from 'vitest';
import { applyReplacements, replacementsProcessor } from '../src/main/postprocess/replacements';
import type { PostProcessContext } from '../src/main/postprocess/pipeline';
import { SettingsSchema, type ReplacementEntry, type Settings } from '../src/shared/types';

function makeSettings(replacements: ReplacementEntry[]): Settings {
  return SettingsSchema.parse({ replacements });
}

function makeCtx(replacements: ReplacementEntry[]): PostProcessContext {
  return { settings: makeSettings(replacements) };
}

describe('applyReplacements', () => {
  it('returns input unchanged when there are no entries', () => {
    expect(applyReplacements('hello world', [])).toBe('hello world');
  });

  it('replaces a trigger at word boundaries (ASCII)', () => {
    const result = applyReplacements('send to email please', [
      { trigger: 'email', expansion: 'macka@example.com', wordBoundary: true }
    ]);
    expect(result).toBe('send to macka@example.com please');
  });

  it('does NOT replace when surrounded by word characters and wordBoundary is true', () => {
    const result = applyReplacements('emails are nice', [
      { trigger: 'email', expansion: 'macka@example.com', wordBoundary: true }
    ]);
    expect(result).toBe('emails are nice');
  });

  it('replaces inside a word when wordBoundary is false', () => {
    const result = applyReplacements('emails are nice', [
      { trigger: 'email', expansion: 'mail', wordBoundary: false }
    ]);
    expect(result).toBe('mails are nice');
  });

  it('replaces multiple occurrences of the same trigger', () => {
    const result = applyReplacements('foo and foo and foo', [
      { trigger: 'foo', expansion: 'bar', wordBoundary: true }
    ]);
    expect(result).toBe('bar and bar and bar');
  });

  it('applies multiple entries in registration order (chaining allowed)', () => {
    const result = applyReplacements('hello world', [
      { trigger: 'hello', expansion: 'hi there', wordBoundary: true },
      { trigger: 'hi there', expansion: 'greetings', wordBoundary: true }
    ]);
    expect(result).toBe('greetings world');
  });

  it('escapes regex special characters in the trigger', () => {
    const result = applyReplacements('price is $1.99 today', [
      { trigger: '$1.99', expansion: '$2.50', wordBoundary: false }
    ]);
    expect(result).toBe('price is $2.50 today');
  });

  it('does not interpret special chars as regex (a.c should not match abc)', () => {
    const result = applyReplacements('abc and a.c', [
      { trigger: 'a.c', expansion: 'XYZ', wordBoundary: false }
    ]);
    expect(result).toBe('abc and XYZ');
  });

  it('respects custom word boundary for Japanese triggers', () => {
    // メアド is surrounded by Japanese punctuation/whitespace -> matches.
    const result = applyReplacements('「メアド」を教えて', [
      { trigger: 'メアド', expansion: 'macka@example.com', wordBoundary: true }
    ]);
    expect(result).toBe('「macka@example.com」を教えて');
  });

  it('does NOT match a Japanese trigger when fused with adjacent kana/kanji', () => {
    // メアドラマ contains メアド followed by ラマ — both are kana-class word
    // chars, so a wordBoundary match must be rejected.
    const result = applyReplacements('メアドラマ', [
      { trigger: 'メアド', expansion: 'EMAIL', wordBoundary: true }
    ]);
    expect(result).toBe('メアドラマ');
  });

  it('matches Japanese trigger at start and end of string', () => {
    const result = applyReplacements('メアド', [
      { trigger: 'メアド', expansion: 'macka@example.com', wordBoundary: true }
    ]);
    expect(result).toBe('macka@example.com');
  });

  it('falls through gracefully on empty input', () => {
    const result = applyReplacements('', [
      { trigger: 'foo', expansion: 'bar', wordBoundary: true }
    ]);
    expect(result).toBe('');
  });
});

describe('replacementsProcessor', () => {
  it('has the expected name', () => {
    expect(replacementsProcessor.name).toBe('replacements');
  });

  it('returns text unchanged when settings.replacements is empty', async () => {
    const ctx = makeCtx([]);
    const out = await replacementsProcessor.process('hello world', ctx);
    expect(out).toBe('hello world');
  });

  it('applies entries from the post-process context', async () => {
    const ctx = makeCtx([
      { trigger: 'メアド', expansion: 'macka@example.com', wordBoundary: true }
    ]);
    const out = await replacementsProcessor.process('「メアド」を教えて', ctx);
    expect(out).toBe('「macka@example.com」を教えて');
  });

  it('skips replacement when context settings has no replacements property values', async () => {
    const ctx = makeCtx([]);
    const out = await replacementsProcessor.process('「メアド」を教えて', ctx);
    expect(out).toBe('「メアド」を教えて');
  });
});
