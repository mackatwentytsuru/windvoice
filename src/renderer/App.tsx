import { useEffect, useState } from 'react';
import type { DictationStatus, Settings } from '../shared/types';
import { useI18n } from './useI18n';
import { GeneralPage } from './pages/General';
import { HotkeysPage } from './pages/Hotkeys';
import { DictionaryPage } from './pages/Dictionary';
import { ReplacementsPage } from './pages/Replacements';
import { HistoryPage } from './pages/History';

type Tab = 'general' | 'hotkeys' | 'dictionary' | 'replacements' | 'history';

export function App(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('general');
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void window.windvoice.getSettings().then(setSettings);
    const off = window.windvoice.onStatus(setStatus);
    return off;
  }, []);

  async function update(partial: Partial<Settings>): Promise<void> {
    const next = await window.windvoice.setSettings(partial);
    setSettings(next);
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>WindVoice</h1>
        <div style={{ marginLeft: 8, marginBottom: 16 }}>
          <span className={`status-pill ${status}`}>{statusLabel(status, t)}</span>
        </div>
        <nav>
          {(
            [
              ['general', t('tab.general')],
              ['hotkeys', t('tab.hotkeys')],
              ['dictionary', t('tab.dictionary')],
              ['replacements', t('tab.replacements')],
              ['history', t('tab.history')]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key as Tab)}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
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
