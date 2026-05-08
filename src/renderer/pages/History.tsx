import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';

export function HistoryPage(): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void window.windvoice.listHistory().then(setEntries);
    const off = window.windvoice.onHistoryChanged(() => {
      void window.windvoice.listHistory().then(setEntries);
    });
    return off;
  }, []);

  async function remove(id: string): Promise<void> {
    const next = await window.windvoice.removeHistory(id);
    setEntries(next);
  }

  async function clearAll(): Promise<void> {
    if (!confirm('Delete all history entries?')) return;
    const next = await window.windvoice.clearHistory();
    setEntries(next);
  }

  function copy(entry: HistoryEntry): void {
    window.windvoice.copyText(entry.transcript);
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1200);
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>History</h2>
        {entries.length > 0 && (
          <button
            onClick={() => void clearAll()}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--fg-dim)',
              padding: '4px 12px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {entries.length === 0 && (
        <p className="helper">
          No transcriptions yet. Use the hotkey or the Test button on General to record one.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((e) => (
          <div
            key={e.id}
            className="history-card"
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 0.04 }}>
                {formatTimestamp(e.timestamp)}
                {e.durationMs !== undefined && ` · ${(e.durationMs / 1000).toFixed(1)}s`}
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button
                  onClick={() => copy(e)}
                  style={iconBtn}
                  title="Copy"
                >
                  {copiedId === e.id ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={() => void remove(e.id)}
                  style={{ ...iconBtn, color: 'var(--error)' }}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, lineHeight: 1.5 }}>
              {e.transcript}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
  padding: '2px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1.4
};

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (sameDay) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
