import { useEffect, useState } from 'react';
import type { DictationStatus, Settings } from '../shared/types';
import { GeneralPage } from './pages/General';
import { HotkeysPage } from './pages/Hotkeys';
import { DictionaryPage } from './pages/Dictionary';
import { HistoryPage } from './pages/History';

type Tab = 'general' | 'hotkeys' | 'dictionary' | 'history';

export function App(): JSX.Element {
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
          <span className={`status-pill ${status}`}>{statusLabel(status)}</span>
        </div>
        <nav>
          {(
            [
              ['general', 'General'],
              ['hotkeys', 'Hotkeys'],
              ['dictionary', 'Dictionary'],
              ['history', 'History']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
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
        {tab === 'history' && <HistoryPage />}
      </main>
    </div>
  );
}

function statusLabel(s: DictationStatus): string {
  switch (s) {
    case 'listening': return 'Listening...';
    case 'processing': return 'Processing...';
    case 'error': return 'Error';
    default: return 'Idle';
  }
}
