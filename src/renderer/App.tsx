import { useEffect, useRef, useState } from 'react';
import type { DictationStatus, Settings } from '../shared/types';
import { useI18n } from './useI18n';
import { GeneralPage } from './pages/General';
import { HotkeysPage } from './pages/Hotkeys';
import { DictionaryPage } from './pages/Dictionary';
import { ReplacementsPage } from './pages/Replacements';
import { AppModesPage } from './pages/AppModes';
import { HistoryPage } from './pages/History';
import { UpdaterBanner } from './UpdaterBanner';

type Tab = 'general' | 'hotkeys' | 'dictionary' | 'replacements' | 'appModes' | 'history';

const TABS: readonly Tab[] = [
  'general',
  'hotkeys',
  'dictionary',
  'replacements',
  'appModes',
  'history'
] as const;

const BANNER_AUTO_DISMISS_MS = 8000;

interface ErrorBanner {
  message: string;
  permanent: boolean;
}

export function App(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('general');
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [banner, setBanner] = useState<ErrorBanner | null>(null);
  const tabRefs = useRef<Map<Tab, HTMLButtonElement | null>>(new Map());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function loadSettings(): void {
    setSettingsLoadError(false);
    void window.windvoice.getSettings().then(
      (next) => setSettings(next),
      () => setSettingsLoadError(true)
    );
  }

  useEffect(() => {
    // Guard against the async settings load resolving after the
    // component unmounts (e.g. React 18 StrictMode double-mount, or a
    // fast-close + reopen of the Settings window). Without this the
    // `setSettings` call lands on a dead component and React warns.
    let cancelled = false;
    setSettingsLoadError(false);
    void window.windvoice.getSettings().then(
      (s) => {
        if (!cancelled) setSettings(s);
      },
      () => {
        if (!cancelled) setSettingsLoadError(true);
      }
    );
    const showBanner = (next: ErrorBanner): void => {
      if (dismissTimerRef.current != null) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      setBanner(next);
      if (!next.permanent) {
        dismissTimerRef.current = setTimeout(() => {
          setBanner(null);
          dismissTimerRef.current = null;
        }, BANNER_AUTO_DISMISS_MS);
      }
    };
    const offStatus = window.windvoice.onStatus((s) => {
      setStatus(s);
      // Permanent formatter errors clear on the next status transition,
      // signalling the system has moved on from the failed cycle.
      setBanner((prev) => (prev?.permanent ? null : prev));
    });
    const offSystem = window.windvoice.onSystemError((p) => {
      // 'notice' carries already-localized, user-facing guidance (e.g. mic
      // not capturing) — show it verbatim. Technical sources (transcription,
      // paste, duck, …) keep the "source:" prefix for debuggability.
      const message = p.source === 'notice' ? p.message : `${p.source}: ${p.message}`;
      showBanner({ message, permanent: false });
    });
    const offFormatter = window.windvoice.onFormatterError((p) => {
      showBanner({ message: p.message, permanent: p.permanent });
    });
    return () => {
      cancelled = true;
      offStatus();
      offSystem();
      offFormatter();
      if (dismissTimerRef.current != null) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, []);

  function dismissBanner(): void {
    if (dismissTimerRef.current != null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setBanner(null);
  }

  async function update(partial: Partial<Settings>): Promise<void> {
    const next = await window.windvoice.setSettings(partial);
    setSettings(next);
  }

  function handleTabKey(e: React.KeyboardEvent<HTMLButtonElement>, current: Tab): void {
    const idx = TABS.indexOf(current);
    let nextIdx: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIdx = (idx + 1) % TABS.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIdx = (idx - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = TABS.length - 1;
        break;
      default:
        return;
    }
    if (nextIdx == null) return;
    const target = TABS[nextIdx];
    if (target == null) return;
    e.preventDefault();
    setTab(target);
    const btn = tabRefs.current.get(target);
    btn?.focus();
  }

  const tabLabels: Record<Tab, string> = {
    general: t('tab.general'),
    hotkeys: t('tab.hotkeys'),
    dictionary: t('tab.dictionary'),
    replacements: t('tab.replacements'),
    appModes: t('tab.appModes'),
    history: t('tab.history')
  };

  return (
    <div className="layout">
      <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
        <h1>WindVoice</h1>
        <div style={{ marginLeft: 8, marginBottom: 16 }}>
          <span className={`status-pill ${status}`}>{statusLabel(status, t)}</span>
        </div>
        <nav role="tablist" aria-label={t('aria.activeTab')}>
          {TABS.map((key) => {
            const active = tab === key;
            return (
              <button
                key={key}
                ref={(el) => {
                  tabRefs.current.set(key, el);
                }}
                role="tab"
                type="button"
                aria-selected={active}
                aria-current={active ? 'page' : undefined}
                tabIndex={active ? 0 : -1}
                className={active ? 'active' : ''}
                onClick={() => setTab(key)}
                onKeyDown={(e) => handleTabKey(e, key)}
              >
                {tabLabels[key]}
              </button>
            );
          })}
        </nav>
        <div style={{ marginTop: 'auto', padding: '12px 8px 0' }}>
          <button
            type="button"
            className="button-secondary"
            style={{ width: '100%', color: 'var(--error)' }}
            onClick={() => void window.windvoice.quit()}
          >
            {t('general.quit')}
          </button>
          <div className="helper">{t('general.quitHelper')}</div>
        </div>
      </aside>
      <main className="main" role="tabpanel" aria-label={tabLabels[tab]}>
        <UpdaterBanner />
        {banner && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              marginBottom: 16,
              border: '1px solid var(--error)',
              borderRadius: 6,
              background: 'color-mix(in oklab, var(--error) 12%, transparent)',
              color: 'var(--error)',
              fontSize: 13,
              lineHeight: 1.4
            }}
          >
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{banner.message}</span>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label={t('aria.delete')}
              title={t('aria.delete')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--error)',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: 16,
                lineHeight: 1
              }}
            >
              ×
            </button>
          </div>
        )}
        {!settings && !settingsLoadError && (
          <div role="status" className="helper">{t('general.loading')}</div>
        )}
        {!settings && settingsLoadError && (
          <div role="alert">
            <p>{t('error.settingsLoadFailed')}</p>
            <button type="button" className="button-secondary" onClick={loadSettings}>
              {t('general.retry')}
            </button>
          </div>
        )}
        {settings && tab === 'general' && (
          <GeneralPage settings={settings} update={update} />
        )}
        {settings && tab === 'hotkeys' && (
          <HotkeysPage settings={settings} update={update} />
        )}
        {settings && tab === 'dictionary' && (
          <DictionaryPage settings={settings} update={update} />
        )}
        {settings && tab === 'replacements' && (
          <ReplacementsPage settings={settings} update={update} />
        )}
        {settings && tab === 'appModes' && (
          <AppModesPage settings={settings} update={update} />
        )}
        {tab === 'history' && <HistoryPage />}
      </main>
    </div>
  );
}

function statusLabel(s: DictationStatus, t: (key: string) => string): string {
  switch (s) {
    case 'listening': return t('status.listening');
    case 'processing': return t('status.processing');
    case 'error': return t('status.error');
    default: return t('status.idle');
  }
}
