import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { useI18n } from '../useI18n';

export function HistoryPage(): JSX.Element {
  const { t, lang } = useI18n();
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
    if (!confirm(t('history.confirmClearAll'))) return;
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
        <h2 style={{ margin: 0 }}>{t('history.title')}</h2>
        {entries.length > 0 && (
          <button className="button-secondary" onClick={() => void clearAll()}>
            {t('history.clearAll')}
          </button>
        )}
      </div>

      {/* Single live region announces copy state changes for screen readers. */}
      <span className="visually-hidden" aria-live="polite">
        {copiedId ? t('aria.copied') : ''}
      </span>

      {entries.length === 0 && (
        <p className="helper">{t('history.empty')}</p>
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
                {formatTimestamp(e.timestamp, lang)}
                {e.durationMs !== undefined && ` · ${(e.durationMs / 1000).toFixed(1)}s`}
              </span>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="button-secondary"
                  onClick={() => copy(e)}
                  aria-label={copiedId === e.id ? t('aria.copied') : t('aria.copy')}
                  title={t('history.copy')}
                >
                  {copiedId === e.id ? t('history.copied') : t('history.copy')}
                </button>
                <button
                  className="button-icon"
                  onClick={() => void remove(e.id)}
                  aria-label={t('aria.delete')}
                  title={t('aria.delete')}
                  style={{ color: 'var(--error)' }}
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

function formatTimestamp(ms: number, lang: string): string {
  const d = new Date(ms);
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(d);
  } catch {
    // Fallback for unusual lang tags.
    return d.toLocaleString();
  }
}
