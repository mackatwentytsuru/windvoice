import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DictationStatus, OverlayState, Settings } from '../shared/types';
import { t, type UiLang } from '../shared/i18n';
import './overlay.css';

function Overlay(): JSX.Element | null {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [level, setLevel] = useState(0);
  const [lang, setLang] = useState<UiLang>('ja');

  useEffect(() => {
    const off = window.windvoice.onOverlayState((s: OverlayState) => {
      setStatus(s.status);
      setLevel(s.level);
    });
    return off;
  }, []);

  useEffect(() => {
    void window.windvoice.getSettings().then((s: Settings) => setLang(s.ui.uiLanguage));
    const off = window.windvoice.onStatus(() => {
      // settings may have changed too; re-fetch
      void window.windvoice.getSettings().then((s: Settings) => setLang(s.ui.uiLanguage));
    });
    return off;
  }, []);

  if (status === 'idle') return null;

  const label =
    status === 'listening'
      ? t('overlay.listening', lang)
      : status === 'processing'
        ? t('overlay.processing', lang)
        : t('status.error', lang);

  return (
    <div className={`overlay overlay-${status}`}>
      <div className="mic" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path
            fill="currentColor"
            d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
          />
        </svg>
      </div>
      <div className="label">{label}</div>
      {status === 'listening' && (
        <div className="meter" aria-hidden="true">
          <div className="meter-fill" style={{ width: `${Math.min(100, level * 140)}%` }} />
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Overlay />
    </StrictMode>
  );
}
