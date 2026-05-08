import { useState } from 'react';
import type { ReplacementEntry, Settings } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function ReplacementsPage({ settings, update }: Props): JSX.Element {
  const { t } = useI18n();
  const [trigger, setTrigger] = useState('');
  const [expansion, setExpansion] = useState('');
  const [wordBoundary, setWordBoundary] = useState(true);

  function add(): void {
    const trimmedTrigger = trigger.trim();
    if (trimmedTrigger.length === 0) return;
    const next: ReplacementEntry[] = [
      ...settings.replacements,
      { trigger: trimmedTrigger, expansion, wordBoundary }
    ];
    void update({ replacements: next });
    setTrigger('');
    setExpansion('');
    setWordBoundary(true);
  }

  function remove(index: number): void {
    const next = settings.replacements.filter((_, i) => i !== index);
    void update({ replacements: next });
  }

  return (
    <>
      <h2>{t('replacements.title')}</h2>
      <p className="helper" style={{ marginBottom: 16 }}>
        {t('replacements.helper')}
      </p>

      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder={t('replacements.trigger')}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        />
        <span style={{ color: 'var(--fg-dim)' }}>→</span>
        <input
          type="text"
          placeholder={t('replacements.expansion')}
          value={expansion}
          onChange={(e) => setExpansion(e.target.value)}
        />
        <button className="primary" onClick={add} disabled={!trigger.trim()}>
          {t('replacements.add')}
        </button>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-dim)' }}>
          <input
            type="checkbox"
            checked={wordBoundary}
            onChange={(e) => setWordBoundary(e.target.checked)}
          />
          {t('replacements.wordBoundary')}
        </label>
      </div>

      {settings.replacements.length === 0 && (
        <p className="helper">{t('replacements.empty')}</p>
      )}
      {settings.replacements.map((r, i) => (
        <div
          key={i}
          className="row"
          style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}
        >
          <span style={{ flex: 1 }}>
            <span className="kbd">{r.trigger}</span>{' '}
            <span style={{ color: 'var(--fg-dim)' }}>→</span>{' '}
            <span className="kbd">{r.expansion}</span>
            {r.wordBoundary && (
              <span style={{ color: 'var(--fg-dim)', marginLeft: 8, fontSize: 12 }}>
                ({t('replacements.wordBoundary')})
              </span>
            )}
          </span>
          <button
            onClick={() => remove(i)}
            style={{
              background: 'transparent',
              color: 'var(--fg-dim)',
              border: 0,
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
