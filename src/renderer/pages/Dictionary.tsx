import { useState } from 'react';
import type { Settings, DictionaryEntry } from '../../shared/types';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function DictionaryPage({ settings, update }: Props): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function add(): void {
    if (!from.trim() || !to.trim()) return;
    const next: DictionaryEntry[] = [
      ...settings.dictionary,
      { from: from.trim(), to: to.trim() }
    ];
    void update({ dictionary: next });
    setFrom('');
    setTo('');
  }

  function remove(index: number): void {
    const next = settings.dictionary.filter((_, i) => i !== index);
    void update({ dictionary: next });
  }

  return (
    <>
      <h2>Dictionary</h2>
      <p className="helper" style={{ marginBottom: 16 }}>
        Replace what the model heard with the canonical spelling. Applied during the formatter step (Phase 2).
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="heard"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span style={{ color: 'var(--fg-dim)' }}>→</span>
        <input
          type="text"
          placeholder="corrected"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button className="primary" onClick={add} disabled={!from || !to}>Add</button>
      </div>

      {settings.dictionary.length === 0 && (
        <p className="helper">No entries yet.</p>
      )}
      {settings.dictionary.map((d, i) => (
        <div key={i} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span style={{ flex: 1 }}>
            <span className="kbd">{d.from}</span>{' '}<span style={{ color: 'var(--fg-dim)' }}>→</span>{' '}
            <span className="kbd">{d.to}</span>
          </span>
          <button onClick={() => remove(i)} style={{ background: 'transparent', color: 'var(--fg-dim)', border: 0, cursor: 'pointer' }}>×</button>
        </div>
      ))}
    </>
  );
}
