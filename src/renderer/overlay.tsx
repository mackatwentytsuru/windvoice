import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { DictationStatus, OverlayState, Settings } from '../shared/types';
import { t, type UiLang } from '../shared/i18n';
import './overlay.css';

function Overlay(): JSX.Element | null {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [level, setLevel] = useState(0);
  const [lang, setLang] = useState<UiLang>('ja');
  const [overlayEnabled, setOverlayEnabled] = useState(true);

  useEffect(() => {
    const off = window.windvoice.onOverlayState((s: OverlayState) => {
      setStatus(s.status);
      setLevel(s.level);
    });
    return off;
  }, []);

  // Pull settings once on mount, then keep up via the dedicated
  // settings:changed event — NOT via status:changed (which fires per
  // dictation and would re-trigger IPC at ~20 Hz during recording).
  useEffect(() => {
    void window.windvoice.getSettings().then((s: Settings) => {
      setLang(s.ui.uiLanguage);
      setOverlayEnabled(s.ui.overlayEnabled);
    });
    const off = window.windvoice.onSettingsChanged((s: Settings) => {
      setLang(s.ui.uiLanguage);
      setOverlayEnabled(s.ui.overlayEnabled);
    });
    return off;
  }, []);

  if (status === 'idle' || !overlayEnabled) return null;

  const label = labelFor(status, lang);
  // overlay.css ships rules for .overlay-listening / -processing / -error.
  // 'connecting' and 'unavailable' fall through to the base .overlay
  // styling, so we layer sensible-color inline overrides for them here
  // without touching the stylesheet.
  const styleOverride = STYLE_FOR.get(status);
  const micStyleOverride = MIC_STYLE_FOR.get(status);

  return (
    <div className={`overlay overlay-${status}`} style={styleOverride}>
      <div className="mic" aria-hidden="true" style={micStyleOverride}>
        {status === 'unavailable' ? (
          // Warning glyph: triangle with exclamation, signals "setup needed".
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              fill="currentColor"
              d="M12 2 1 21h22L12 2zm0 6 7.5 13H4.5L12 8zm-1 5h2v4h-2v-4zm0 5h2v2h-2v-2z"
            />
          </svg>
        ) : status === 'connecting' ? (
          // Spinner glyph: a partial ring; CSS animates it via .overlay-connecting .mic.
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              fill="currentColor"
              d="M12 4a8 8 0 0 1 8 8h-2a6 6 0 0 0-6-6V4z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              fill="currentColor"
              d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
            />
          </svg>
        )}
      </div>
      <div className="label" role="status" aria-live="polite">{label}</div>
      {status === 'listening' && (
        <div className="meter" aria-hidden="true">
          <div className="meter-fill" style={{ width: `${Math.min(100, level * 140)}%` }} />
        </div>
      )}
    </div>
  );
}

// Inline-only color overrides for status branches the stylesheet does
// not cover. Neutral grey for 'connecting' (don't pretend it's good or
// bad yet), warm amber for 'unavailable' (the user has to act).
const STYLE_FOR = new Map<DictationStatus, CSSProperties>([
  [
    'connecting',
    {
      borderColor: 'rgba(180, 184, 192, 0.55)',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)'
    }
  ],
  [
    'unavailable',
    {
      borderColor: 'rgba(240, 195, 100, 0.6)',
      color: '#f0c364',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45), 0 0 12px rgba(240, 195, 100, 0.22)'
    }
  ]
]);

const MIC_STYLE_FOR = new Map<DictationStatus, CSSProperties>([
  ['connecting', { color: '#b4b8c0' }],
  ['unavailable', { color: '#f0c364' }]
]);

/**
 * Maps a DictationStatus to its overlay label. 'idle' is unreachable here
 * (filtered above) but listed for exhaustiveness. The 'connecting' and
 * 'unavailable' branches fall back to hardcoded strings when their i18n
 * key is missing — the table currently ships only the four legacy keys.
 */
function labelFor(status: DictationStatus, lang: UiLang): string {
  switch (status) {
    case 'listening':
      return t('overlay.listening', lang);
    case 'processing':
      return t('overlay.processing', lang);
    case 'connecting':
      return lang === 'ja' ? '接続中…' : 'Connecting...';
    case 'unavailable':
      return lang === 'ja' ? 'セットアップが必要' : 'Setup needed';
    case 'error':
      return t('status.error', lang);
    case 'idle':
    default:
      return '';
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Overlay />
    </StrictMode>
  );
}
