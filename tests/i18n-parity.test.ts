import { describe, expect, it } from 'vitest';
import { t, hasKey, UI_LANGS, type UiLang } from '../src/shared/i18n';

// Build the keysets by reading the i18n.ts source. The module only exports
// `t` and `hasKey`; we can derive the per-language keysets by probing every
// key found in the canonical Japanese table via `hasKey` plus the English
// table via the `t` fall-through behaviour.
//
// In practice we read the source file once to find every key literal, then
// split them by the dictionary they belong to.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadKeysFromSource(): { ja: Set<string>; en: Set<string> } {
  const src = readFileSync(resolve('src/shared/i18n.ts'), 'utf8');

  // Find the `const ja: Dict = { ... }` and `const en: Dict = { ... }` blocks.
  function extract(name: 'ja' | 'en'): Set<string> {
    const re = new RegExp(`const ${name}: Dict = \\{([\\s\\S]*?)\\n\\};`, 'm');
    const m = src.match(re);
    if (!m) throw new Error(`could not locate '${name}' table in i18n.ts`);
    const body = m[1]!;
    const keys = new Set<string>();
    // Match either single- or double-quoted keys followed by a colon.
    const keyRe = /['"]([^'"]+)['"]\s*:/g;
    for (const km of body.matchAll(keyRe)) {
      keys.add(km[1]!);
    }
    return keys;
  }

  return { ja: extract('ja'), en: extract('en') };
}

describe('i18n parity', () => {
  const { ja: jaKeys, en: enKeys } = loadKeysFromSource();

  it('en is a superset of ja (no missing English translations)', () => {
    const missing: string[] = [];
    for (const k of jaKeys) {
      if (!enKeys.has(k)) missing.push(k);
    }
    expect(missing).toEqual([]);
  });

  const requiredKeys = [
    'aria.delete',
    'aria.copy',
    'aria.copied',
    'aria.activeTab',
    'general.apiKeyHelper.darwin',
    'general.apiKeyHelper.win32',
    'general.apiKeyHelper.linux',
    'general.insertionPaste.darwin',
    'general.insertionPaste.win32',
    'firstRun.apiKey.darwin',
    'firstRun.apiKey.win32',
    'error.apiKeyInvalid',
    'error.secureStoreUnavailable',
    'hotkeys.duplicate',
    'hotkeys.recordHint'
  ];

  for (const key of requiredKeys) {
    it(`required key '${key}' exists in both languages`, () => {
      expect(jaKeys.has(key), `missing in ja: ${key}`).toBe(true);
      expect(enKeys.has(key), `missing in en: ${key}`).toBe(true);
      // And t() returns a non-empty, non-placeholder string for both.
      for (const lang of ['ja', 'en'] as UiLang[]) {
        const v = t(key, lang);
        expect(v.startsWith('[missing:'), `placeholder for ${key}/${lang}`).toBe(false);
        expect(v.length).toBeGreaterThan(0);
      }
    });
  }

  it('no key returns the literal "[missing:" prefix or empty string', () => {
    for (const lang of UI_LANGS.map((l) => l.value)) {
      for (const k of jaKeys) {
        const v = t(k, lang);
        expect(v.startsWith('[missing:'), `placeholder for ${k}/${lang}`).toBe(false);
        expect(v.length, `empty for ${k}/${lang}`).toBeGreaterThan(0);
      }
    }
  });

  it('t() falls back gracefully for an unknown key', () => {
    const unknown = 'this.key.definitely.does.not.exist';
    for (const lang of UI_LANGS.map((l) => l.value)) {
      let result: unknown;
      expect(() => {
        result = t(unknown, lang);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    }
  });

  it('hasKey() returns true for known keys and false for unknown', () => {
    expect(hasKey('tab.general')).toBe(true);
    expect(hasKey('aria.delete')).toBe(true);
    expect(hasKey('hotkeys.duplicate')).toBe(true);
    expect(hasKey('this.key.does.not.exist')).toBe(false);
    expect(hasKey('')).toBe(false);
  });
});
