import { useEffect, useState } from 'react';
import { t as translate, hasKey, type I18nKey, type UiLang } from '../shared/i18n';
import type { Settings } from '../shared/types';

let cachedLang: UiLang = 'ja';
const subscribers = new Set<(lang: UiLang) => void>();
let initialized = false;

function setCached(next: UiLang): void {
  if (next === cachedLang) return;
  cachedLang = next;
  subscribers.forEach((cb) => cb(cachedLang));
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  // Defensive: window.windvoice is attached by preload; only call when present.
  if (typeof window === 'undefined' || !window.windvoice) return;
  void window.windvoice.getSettings().then((s: Settings) => setCached(s.ui.uiLanguage));
  window.windvoice.onSettingsChanged((s: Settings) => setCached(s.ui.uiLanguage));
}

/**
 * Detect the host platform without depending on the preload-exposed
 * `window.api.platform` (older preload builds may not expose it). Falls back
 * to inspecting `navigator.userAgent` for a coarse classification.
 */
export function detectPlatform(): 'darwin' | 'win32' | 'linux' | string {
  if (typeof window !== 'undefined') {
    // Preferred: preload-exposed string ("darwin" | "win32" | "linux" | ...).
    const fromApi = (window as unknown as { api?: { platform?: string } }).api?.platform;
    if (typeof fromApi === 'string' && fromApi.length > 0) return fromApi;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac os') || ua.includes('macintosh')) return 'darwin';
    if (ua.includes('windows')) return 'win32';
    if (ua.includes('linux')) return 'linux';
  }
  return 'unknown';
}

export function useI18n(): {
  t: (key: I18nKey | string) => string;
  tPlatform: (prefix: string) => string;
  lang: UiLang;
  setLang: (lang: UiLang) => Promise<void>;
} {
  const [lang, setLangState] = useState<UiLang>(cachedLang);

  useEffect(() => {
    ensureInitialized();
    const cb = (next: UiLang): void => setLangState(next);
    subscribers.add(cb);
    setLangState(cachedLang);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  const tPlatform = (prefix: string): string => {
    const platform = detectPlatform();
    const candidate = `${prefix}.${platform}`;
    if (hasKey(candidate)) return translate(candidate, lang);
    return translate(prefix, lang);
  };

  return {
    lang,
    t: (key: I18nKey | string) => translate(key, lang),
    tPlatform,
    setLang: async (next: UiLang) => {
      const settings = await window.windvoice.getSettings();
      const updated = await window.windvoice.setSettings({
        ui: { ...settings.ui, uiLanguage: next }
      });
      // Settings broadcast will also notify, but update locally first for snappiness.
      setCached(updated.ui.uiLanguage);
    }
  };
}
