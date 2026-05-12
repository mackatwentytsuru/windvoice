import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Settings, HotkeyBinding } from '../../shared/types';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

type ModifierToken = 'Ctrl' | 'LeftCtrl' | 'RightCtrl' | 'Alt' | 'LeftAlt' | 'RightAlt' | 'Shift' | 'LeftShift' | 'RightShift' | 'Meta' | 'LeftMeta' | 'RightMeta';

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
  // Distinguish Left vs Right Cmd so a user can bind dictation to the RIGHT
  // Cmd alone, keeping the LEFT Cmd free for normal Cmd+C / Cmd+V combos.
  MetaLeft: 'LeftMeta',
  MetaRight: 'RightMeta',
  OSLeft: 'LeftMeta',
  OSRight: 'RightMeta'
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
 * Build the array of key tokens for a chord (modifier + non-modifier).
 * Returns null if the trigger code isn't representable.
 */
function chordToKeys(e: KeyboardEvent): string[] | null {
  const trigger = codeToTriggerToken(e.code);
  if (trigger == null) return null;
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
    tokens.push(e.location === 2 ? 'RightMeta' : 'LeftMeta');
  }
  tokens.push(trigger);
  return tokens;
}

/**
 * Compute a stable equality key for a bindings.keys array (order-insensitive).
 */
function bindingKeysSignature(keys: string[]): string {
  return [...keys].map((k) => k.toLowerCase()).sort().join('+');
}

interface RowProps {
  binding: HotkeyBinding;
  index: number;
  canRemove: boolean;
  duplicate: boolean;
  /** Returns false when the change was refused (e.g. duplicate keys). */
  onPatch: (id: string, change: Partial<HotkeyBinding>) => boolean;
  onRemove: (id: string) => void;
}

function HotkeyRow({ binding, index, canRemove, duplicate, onPatch, onRemove }: RowProps): JSX.Element {
  const { t } = useI18n();
  const [recording, setRecording] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Track the bare modifier the user pressed first (if any). We commit when
  // either a non-modifier trigger arrives, or all keys are released and the
  // recording was a single bare modifier.
  const pendingModifierRef = useRef<ModifierToken | null>(null);
  const pressedCodesRef = useRef<Set<string>>(new Set());

  const stopRecording = useCallback((): void => {
    setRecording(false);
    pendingModifierRef.current = null;
    pressedCodesRef.current = new Set();
  }, []);

  const tryCommit = useCallback(
    (keys: string[]): void => {
      const ok = onPatch(binding.id, { keys });
      if (ok) {
        setError(null);
        stopRecording();
      } else {
        setError(t('hotkeys.duplicate'));
        stopRecording();
      }
    },
    [binding.id, onPatch, stopRecording, t]
  );

  useEffect(() => {
    if (!recording) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' && e.code === 'Escape') {
        stopRecording();
        return;
      }

      pressedCodesRef.current.add(e.code);

      // Bare modifier: don't commit yet — wait for either a non-modifier
      // trigger (=> chord) or a keyup of all modifiers (=> bare modifier).
      const bare = MODIFIER_CODE_TO_TOKEN[e.code];
      if (bare !== undefined) {
        pendingModifierRef.current = bare;
        return;
      }

      // Trigger key with optional modifiers — commit immediately.
      const keys = chordToKeys(e);
      if (keys == null) {
        setError(t('hotkeys.invalidCombo'));
        return;
      }
      tryCommit(keys);
    };

    const handleKeyUp = (e: KeyboardEvent): void => {
      pressedCodesRef.current.delete(e.code);

      // If we previously saw a bare modifier and the user released ALL keys
      // without ever pressing a non-modifier key, commit the bare modifier.
      if (pendingModifierRef.current != null && pressedCodesRef.current.size === 0) {
        // Only commit the bare modifier when the only pressed code matched
        // a modifier (the typical use-case, e.g. RightAlt push-to-talk).
        const released = MODIFIER_CODE_TO_TOKEN[e.code];
        if (released !== undefined) {
          tryCommit([pendingModifierRef.current]);
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [recording, stopRecording, tryCommit, t]);

  const startRecording = (): void => {
    setError(null);
    pendingModifierRef.current = null;
    pressedCodesRef.current = new Set();
    setRecording(true);
  };

  // Direct one-click binder for the macOS Fn (Globe) key. We can't rely on
  // capturing Fn through `keydown` — Chromium routes Fn through the macOS
  // text-input system rather than as a normal key event, so the user would
  // press the key during recording and nothing would commit. The explicit
  // button bypasses the capture path entirely and writes the binding
  // directly. Backed at runtime by the fnwatcher sidecar (CGEventTap) that
  // injects FN keycodes into the hotkey manager.
  const bindFnKey = useCallback((): void => {
    setError(null);
    setRecording(false);
    const ok = onPatch(binding.id, { keys: ['Fn'] });
    if (!ok) setError(t('hotkeys.duplicate'));
  }, [binding.id, onPatch, t]);

  return (
    <div className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="field-label" style={{ marginBottom: 0, flex: 1 }}>
          {t('hotkeys.binding')} #{index + 1}
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
          <>
            <button type="button" className="button-secondary" onClick={startRecording}>
              {t('hotkeys.record')}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={bindFnKey}
              style={{ marginLeft: 8 }}
              title={t('hotkeys.useFnHint')}
            >
              {t('hotkeys.useFn')}
            </button>
          </>
        )}
        <button
          type="button"
          className="button-icon"
          aria-label={t('aria.delete')}
          onClick={() => onRemove(binding.id)}
          disabled={!canRemove}
          title={!canRemove ? t('hotkeys.cannotRemoveLast') : t('aria.delete')}
          style={{ marginLeft: 'auto' }}
        >
          ×
        </button>
      </div>
      {recording && (
        <div className="helper" style={{ marginBottom: 8 }}>
          {t('hotkeys.recordHint')}
        </div>
      )}
      {error != null && (
        <div className="row" style={{ color: 'var(--error)', marginBottom: 8 }}>
          {error}
        </div>
      )}
      {duplicate && (
        <div className="row" style={{ color: 'var(--error)', marginBottom: 8 }}>
          {t('hotkeys.duplicate')}
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

  // Compute which binding ids collide with another binding's keys.
  const duplicateIds = useMemo<Set<string>>(() => {
    const seen = new Map<string, string>();
    const dupes = new Set<string>();
    for (const h of settings.hotkeys) {
      const sig = bindingKeysSignature(h.keys);
      if (seen.has(sig)) {
        dupes.add(h.id);
        const previous = seen.get(sig);
        if (previous) dupes.add(previous);
      } else {
        seen.set(sig, h.id);
      }
    }
    return dupes;
  }, [settings.hotkeys]);

  const patch = useCallback(
    (id: string, change: Partial<HotkeyBinding>): boolean => {
      // Uniqueness check: if the new keys collide with another binding,
      // refuse to save and signal the caller so it can show an inline error.
      if (change.keys != null) {
        const newSig = bindingKeysSignature(change.keys);
        const collision = settings.hotkeys.some(
          (h) => h.id !== id && bindingKeysSignature(h.keys) === newSig
        );
        if (collision) return false;
      }
      const next = settings.hotkeys.map((h) => (h.id === id ? { ...h, ...change } : h));
      void update({ hotkeys: next });
      return true;
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
      {settings.hotkeys.map((h, i) => (
        <HotkeyRow
          key={h.id}
          binding={h}
          index={i}
          canRemove={canRemove}
          duplicate={duplicateIds.has(h.id)}
          onPatch={patch}
          onRemove={remove}
        />
      ))}
      <div className="row" style={{ marginTop: 16 }}>
        <button type="button" className="button-secondary" onClick={add}>
          {t('hotkeys.addBinding')}
        </button>
      </div>
      <p className="helper">{t('hotkeys.helper')}</p>
    </>
  );
}

