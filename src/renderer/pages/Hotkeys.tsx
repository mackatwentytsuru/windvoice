import { useCallback, useEffect, useState } from 'react';
import type { Settings, HotkeyBinding } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

type ModifierToken = 'Ctrl' | 'LeftCtrl' | 'RightCtrl' | 'Alt' | 'LeftAlt' | 'RightAlt' | 'Shift' | 'LeftShift' | 'RightShift' | 'Meta';

/**
 * Codes that represent a modifier key being pressed in isolation. When the user
 * presses one of these without combining it with another key, the binding is
 * just the bare modifier (e.g. RightAlt for the default WindVoice hotkey).
 */
const MODIFIER_CODE_TO_TOKEN: Readonly<Record<string, ModifierToken>> = {
  AltLeft: 'LeftAlt',
  AltRight: 'RightAlt',
  ControlLeft: 'LeftCtrl',
  ControlRight: 'RightCtrl',
  ShiftLeft: 'LeftShift',
  ShiftRight: 'RightShift',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  OSLeft: 'Meta',
  OSRight: 'Meta'
};

/**
 * Map a non-modifier `event.code` to the token format the main-process
 * `lookupKey()` recognizes. Returns null if the code isn't supported.
 */
function codeToTriggerToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) {
    const ch = code.slice(3);
    return ch.length === 1 ? ch : null;
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-5])$/.test(code)) {
    return code;
  }
  switch (code) {
    case 'Space':
    case 'Enter':
    case 'Tab':
    case 'CapsLock':
      return code;
    default:
      return null;
  }
}

/**
 * Build the array of key tokens to persist into `HotkeyBinding.keys` from a
 * KeyboardEvent. Returns null if the combo isn't representable.
 */
function eventToKeys(e: KeyboardEvent): string[] | null {
  // Bare-modifier press: `event.code` itself is a modifier. Save just that
  // single token even though the corresponding modifier flag is also true.
  const bareModifier = MODIFIER_CODE_TO_TOKEN[e.code];
  if (bareModifier !== undefined) {
    return [bareModifier];
  }

  const trigger = codeToTriggerToken(e.code);
  if (trigger == null) {
    return null;
  }

  const tokens: string[] = [];
  if (e.ctrlKey) {
    tokens.push(e.location === 2 ? 'RightCtrl' : 'LeftCtrl');
  }
  if (e.altKey) {
    tokens.push(e.location === 2 ? 'RightAlt' : 'LeftAlt');
  }
  if (e.shiftKey) {
    tokens.push(e.location === 2 ? 'RightShift' : 'LeftShift');
  }
  if (e.metaKey) {
    tokens.push('Meta');
  }
  tokens.push(trigger);
  return tokens;
}

interface RowProps {
  binding: HotkeyBinding;
  canRemove: boolean;
  onPatch: (id: string, change: Partial<HotkeyBinding>) => void;
  onRemove: (id: string) => void;
}

function HotkeyRow({ binding, canRemove, onPatch, onRemove }: RowProps): JSX.Element {
  const { t } = useI18n();
  const [recording, setRecording] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const stopRecording = useCallback((): void => {
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;

    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' && e.code === 'Escape') {
        stopRecording();
        return;
      }

      const keys = eventToKeys(e);
      if (keys == null) {
        setError(t('hotkeys.invalidCombo'));
        return;
      }
      setError(null);
      onPatch(binding.id, { keys });
      stopRecording();
    };

    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
    };
  }, [recording, binding.id, onPatch, stopRecording, t]);

  return (
    <div className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="field-label" style={{ marginBottom: 0, flex: 1 }}>
          {t('hotkeys.binding')} · {binding.id}
        </span>
        <span>
          {binding.keys.map((k, i) => (
            <span key={`${k}-${i}`} className="kbd" style={{ marginRight: 4 }}>
              {k}
            </span>
          ))}
        </span>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        {recording ? (
          <span style={{ flex: 1, color: 'var(--accent)' }}>
            {t('hotkeys.recordingPrompt')}
          </span>
        ) : (
          <button type="button" onClick={() => { setError(null); setRecording(true); }}>
            {t('hotkeys.record')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onRemove(binding.id)}
          disabled={!canRemove}
          title={!canRemove ? t('hotkeys.cannotRemoveLast') : undefined}
          style={{ marginLeft: 'auto' }}
        >
          ×
        </button>
      </div>
      {error != null && (
        <div className="row" style={{ color: 'var(--danger, #c33)', marginBottom: 8 }}>
          {error}
        </div>
      )}
      <div className="row">
        <label>
          <input
            type="radio"
            checked={binding.mode === 'push-to-talk'}
            onChange={() => onPatch(binding.id, { mode: 'push-to-talk' })}
          />{' '}
          {t('hotkeys.modePush')}
        </label>
        <label>
          <input
            type="radio"
            checked={binding.mode === 'toggle'}
            onChange={() => onPatch(binding.id, { mode: 'toggle' })}
          />{' '}
          {t('hotkeys.modeToggle')}
        </label>
      </div>
    </div>
  );
}

export function HotkeysPage({ settings, update }: Props): JSX.Element {
  const { t } = useI18n();

  const patch = useCallback(
    (id: string, change: Partial<HotkeyBinding>): void => {
      const next = settings.hotkeys.map((h) => (h.id === id ? { ...h, ...change } : h));
      void update({ hotkeys: next });
    },
    [settings.hotkeys, update]
  );

  const remove = useCallback(
    (id: string): void => {
      if (settings.hotkeys.length <= 1) return;
      const next = settings.hotkeys.filter((h) => h.id !== id);
      void update({ hotkeys: next });
    },
    [settings.hotkeys, update]
  );

  const add = useCallback((): void => {
    const newBinding: HotkeyBinding = {
      id: `binding-${Date.now()}`,
      keys: ['F13'],
      mode: 'push-to-talk',
      format: true
    };
    void update({ hotkeys: [...settings.hotkeys, newBinding] });
  }, [settings.hotkeys, update]);

  const canRemove = settings.hotkeys.length > 1;

  return (
    <>
      <h2>{t('hotkeys.title')}</h2>
      {settings.hotkeys.map((h) => (
        <HotkeyRow
          key={h.id}
          binding={h}
          canRemove={canRemove}
          onPatch={patch}
          onRemove={remove}
        />
      ))}
      <div className="row" style={{ marginTop: 16 }}>
        <button type="button" onClick={add}>
          {t('hotkeys.addBinding')}
        </button>
      </div>
      <p className="helper">{t('hotkeys.helper')}</p>
    </>
  );
}
