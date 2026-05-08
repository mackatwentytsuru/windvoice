import { useEffect, useState } from 'react';
import { t as translate, type I18nKey, type UiLang } from '../shared/i18n';
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

export function useI18n(): {
  t: (key: I18nKey) => string;
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

  return {
    lang,
    t: (key: I18nKey) => translate(key, lang),
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
