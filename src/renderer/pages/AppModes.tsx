import { useState } from 'react';
import type { AppProfile, Settings } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

/**
 * Per-app formatter profiles. Each profile matches the foreground app by
 * name and adds extra instructions to the GPT formatter prompt — e.g.
 * terse / no-markdown for a terminal, casual tone for a chat app.
 */
export function AppModesPage({ settings, update }: Props): JSX.Element {
  const { t } = useI18n();
  const [match, setMatch] = useState('');
  const [instructions, setInstructions] = useState('');

  const profiles = settings.formatter.appProfiles;

  function save(next: AppProfile[]): void {
    void update({ formatter: { ...settings.formatter, appProfiles: next } });
  }

  function add(): void {
    const trimmedMatch = match.trim();
    if (trimmedMatch.length === 0) return;
    save([...profiles, { match: trimmedMatch, instructions: instructions.trim() }]);
    setMatch('');
    setInstructions('');
  }

  function remove(index: number): void {
    save(profiles.filter((_, i) => i !== index));
  }

  return (
    <>
      <h2>{t('appModes.title')}</h2>
      <p className="helper" style={{ marginBottom: 16 }}>
        {t('appModes.helper')}
      </p>

      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder={t('appModes.matchPlaceholder')}
          value={match}
          onChange={(e) => setMatch(e.target.value)}
          style={{ flex: '0 0 180px' }}
        />
        <input
          type="text"
          placeholder={t('appModes.instructionsPlaceholder')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="primary" onClick={add} disabled={!match.trim()}>
          {t('appModes.add')}
        </button>
      </div>

      {profiles.length === 0 && <p className="helper">{t('appModes.empty')}</p>}
      {profiles.map((p, i) => (
        <div
          key={i}
          className="row"
          style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}
        >
          <span style={{ flex: 1 }}>
            <span className="chip">{p.match}</span>{' '}
            <span style={{ color: 'var(--fg-dim)' }}>→</span>{' '}
            <span style={{ color: 'var(--fg-dim)' }}>
              {p.instructions || t('appModes.noInstructions')}
            </span>
          </span>
          <button
            className="button-icon"
            onClick={() => remove(i)}
            aria-label={t('aria.delete')}
            title={t('aria.delete')}
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
