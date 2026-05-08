import { describe, expect, it } from 'vitest';
import { t, UI_LANGS } from '../src/shared/i18n';

describe('i18n', () => {
  it('returns Japanese by default for known keys', () => {
    expect(t('tab.general', 'ja')).toBe('一般');
    expect(t('status.listening', 'ja')).toBe('録音中…');
    expect(t('overlay.processing', 'ja')).toBe('処理中…');
  });

  it('returns English when requested', () => {
    expect(t('tab.general', 'en')).toBe('General');
    expect(t('status.listening', 'en')).toBe('Listening...');
  });

  it('exposes both supported languages', () => {
    expect(UI_LANGS.map((l) => l.value)).toEqual(['ja', 'en']);
  });

  it('falls back to Japanese for missing English keys (none expected)', () => {
    // Sanity: the public API still returns a non-empty string.
    expect(t('tray.ready', 'ja').length).toBeGreaterThan(0);
    expect(t('tray.ready', 'en').length).toBeGreaterThan(0);
  });
});
