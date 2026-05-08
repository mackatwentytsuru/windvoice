import type { Settings, HotkeyBinding } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function HotkeysPage({ settings, update }: Props): JSX.Element {
  const { t } = useI18n();

  function patch(id: string, change: Partial<HotkeyBinding>): void {
    const next = settings.hotkeys.map((h) => (h.id === id ? { ...h, ...change } : h));
    void update({ hotkeys: next });
  }

  return (
    <>
      <h2>{t('hotkeys.title')}</h2>
      {settings.hotkeys.map((h) => (
        <div key={h.id} className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="field-label" style={{ marginBottom: 0, flex: 1 }}>
              {t('hotkeys.binding')} · {h.id}
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
              {t('hotkeys.modePush')}
            </label>
            <label>
              <input
                type="radio"
                checked={h.mode === 'toggle'}
                onChange={() => patch(h.id, { mode: 'toggle' })}
              />{' '}
              {t('hotkeys.modeToggle')}
            </label>
          </div>
        </div>
      ))}
      <p className="helper">{t('hotkeys.helper')}</p>
    </>
  );
}
