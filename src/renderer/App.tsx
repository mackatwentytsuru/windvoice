import { useEffect, useRef, useState } from 'react';
import type { DictationStatus, Settings } from '../shared/types';
import { useI18n } from './useI18n';
import { GeneralPage } from './pages/General';
import { HotkeysPage } from './pages/Hotkeys';
import { DictionaryPage } from './pages/Dictionary';
import { ReplacementsPage } from './pages/Replacements';
import { HistoryPage } from './pages/History';

type Tab = 'general' | 'hotkeys' | 'dictionary' | 'replacements' | 'history';

const TABS: readonly Tab[] = ['general', 'hotkeys', 'dictionary', 'replacements', 'history'] as const;

export function App(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('general');
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [settings, setSettings] = useState<Settings | null>(null);
  const tabRefs = useRef<Map<Tab, HTMLButtonElement | null>>(new Map());

  useEffect(() => {
    void window.windvoice.getSettings().then(setSettings);
    const off = window.windvoice.onStatus(setStatus);
    return off;
  }, []);

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
    history: t('tab.history')
  };

  return (
    <div className="layout">
      <aside className="sidebar">
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
      </aside>
      <main className="main" role="tabpanel" aria-label={tabLabels[tab]}>
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
