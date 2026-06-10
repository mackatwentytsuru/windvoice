import { useState } from 'react';
import type { AppProfile, Settings } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

/**
 * Derive a stable React key per profile row. AppProfile has no `id`
 * field, and adding one would mean a schema migration touching every
 * existing settings file — so keys are derived from row CONTENT instead.
 * With `key={index}` (the previous behavior) deleting a row made React
 * reuse the following sibling's element state under the deleted row's
 * key; content keys keep identity attached to the data. Exact-duplicate
 * profiles are disambiguated with a per-content occurrence counter, so
 * the n-th duplicate keeps its key as long as earlier duplicates remain.
 * NUL (`\u0000`) is used as the field separator because it cannot be
 * typed into the inputs, so distinct (match, instructions) pairs can
 * never collide. Exported for unit tests.
 */
export function profileRowKeys(profiles: readonly AppProfile[]): string[] {
  const seen = new Map<string, number>();
  return profiles.map((p) => {
    const base = `${p.match}\u0000${p.instructions}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}\u0000${n}`;
  });
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
  const rowKeys = profileRowKeys(profiles);

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
          key={rowKeys[i]}
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
