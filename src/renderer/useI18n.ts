import { useEffect, useState } from 'react';
import { t as translate, type I18nKey, type UiLang } from '../shared/i18n';

let cachedLang: UiLang = 'ja';
const subscribers = new Set<(lang: UiLang) => void>();

async function loadLang(): Promise<void> {
  const s = await window.windvoice.getSettings();
  if (s.ui.uiLanguage !== cachedLang) {
    cachedLang = s.ui.uiLanguage;
    subscribers.forEach((cb) => cb(cachedLang));
  }
}

void loadLang();

export function useI18n(): {
  t: (key: I18nKey) => string;
  lang: UiLang;
  setLang: (lang: UiLang) => Promise<void>;
} {
  const [lang, setLangState] = useState<UiLang>(cachedLang);

  useEffect(() => {
    const cb = (next: UiLang): void => setLangState(next);
    subscribers.add(cb);
    void loadLang();
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  return {
    lang,
    t: (key: I18nKey) => translate(key, lang),
    setLang: async (next: UiLang) => {
      const updated = await window.windvoice.setSettings({
        ui: { ...(await window.windvoice.getSettings()).ui, uiLanguage: next }
      });
      cachedLang = updated.ui.uiLanguage;
      subscribers.forEach((cb) => cb(cachedLang));
    }
  };
}
