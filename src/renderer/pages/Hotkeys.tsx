import type { Settings, HotkeyBinding } from '../../shared/types';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function HotkeysPage({ settings, update }: Props): JSX.Element {
  function patch(id: string, change: Partial<HotkeyBinding>): void {
    const next = settings.hotkeys.map((h) => (h.id === id ? { ...h, ...change } : h));
    void update({ hotkeys: next });
  }

  return (
    <>
      <h2>Hotkeys</h2>
      {settings.hotkeys.map((h) => (
        <div key={h.id} className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="field-label" style={{ marginBottom: 0, flex: 1 }}>
              Binding · {h.id}
            </span>
            <span>
              {h.keys.map((k, i) => (
                <span key={i} className="kbd" style={{ marginRight: 4 }}>{k}</span>
              ))}
            </span>
          </div>
          <div className="row">
            <label>
              <input
                type="radio"
                checked={h.mode === 'push-to-talk'}
                onChange={() => patch(h.id, { mode: 'push-to-talk' })}
              />{' '}
              Push to talk
            </label>
            <label>
              <input
                type="radio"
                checked={h.mode === 'toggle'}
                onChange={() => patch(h.id, { mode: 'toggle' })}
              />{' '}
              Toggle
            </label>
          </div>
        </div>
      ))}
      <p className="helper">
        Editable key remapping UI is Phase 2. The default <span className="kbd">RightAlt</span> is wired in code.
      </p>
    </>
  );
}
