import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function GeneralPage({ settings, update }: Props): JSX.Element {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState('');
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    const offFinal = window.windvoice.onTranscriptFinal((text) => {
      if (text.startsWith('[error]')) {
        setTestError(text.replace(/^\[error\]\s*/, ''));
      } else {
        setLastTranscript(text);
      }
    });
    const offAudioErr = window.windvoice.onAudioError((msg) => setTestError(msg));
    void window.windvoice.getLastAudioError().then((m) => m && setTestError(m));
    return () => {
      offFinal();
      offAudioErr();
    };
  }, []);

  async function runTest(): Promise<void> {
    setTesting(true);
    setTestError(null);
    setLastTranscript('');
    try {
      await window.windvoice.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      await window.windvoice.stop();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    void window.windvoice.hasApiKey().then(setHasKey);
  }, []);

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      await window.windvoice.setApiKey(keyInput.trim());
      setHasKey(true);
      setKeyInput('');
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h2>General</h2>

      <label className="field">
        <span className="field-label">OpenAI API Key</span>
        <div className="row">
          <input
            type="password"
            placeholder={hasKey ? '•••••• (saved in Credential Manager)' : 'sk-...'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoComplete="off"
          />
          <button
            className="primary"
            onClick={saveKey}
            disabled={saving || !keyInput.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
        <div className="helper">
          Stored via Windows Credential Manager. Not written to disk.
          {savedAt && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>Saved.</span>}
        </div>
      </label>

      <label className="field">
        <span className="field-label">Language</span>
        <select
          value={settings.language}
          onChange={(e) => void update({ language: e.target.value })}
        >
          <option value="auto">Auto-detect</option>
          <option value="ja">Japanese (ja)</option>
          <option value="en">English (en)</option>
          <option value="zh">Chinese (zh)</option>
          <option value="ko">Korean (ko)</option>
        </select>
      </label>

      <label className="field">
        <span className="field-label">Insertion method</span>
        <select
          value={settings.insertion.method}
          onChange={(e) =>
            void update({
              insertion: {
                ...settings.insertion,
                method: e.target.value as 'paste' | 'type'
              }
            })
          }
        >
          <option value="paste">Clipboard paste (Ctrl+V)</option>
          <option value="type" disabled>Type per character (Phase 3)</option>
        </select>
      </label>

      <label className="field">
        <span className="field-label">Formatter</span>
        <div className="row">
          <input
            type="checkbox"
            checked={settings.formatter.enabled}
            onChange={(e) =>
              void update({
                formatter: { ...settings.formatter, enabled: e.target.checked }
              })
            }
          />
          <span>Enable GPT post-processing (Phase 2)</span>
        </div>
        <div className="helper">
          Adds punctuation, applies dictionary, and interprets natural-language formatting commands.
        </div>
      </label>

      <div className="field" style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">Diagnostics</span>
        <div className="row">
          <button className="primary" onClick={() => void runTest()} disabled={testing || !hasKey}>
            {testing ? 'Recording 3 s...' : 'Test dictation (3 s)'}
          </button>
          <span className="helper" style={{ marginTop: 0 }}>
            Record 3 seconds without using a hotkey, then paste the transcript at your cursor.
          </span>
        </div>
        {testError && (
          <div className="helper" style={{ color: 'var(--error)', marginTop: 8 }}>
            {testError}
          </div>
        )}
        {lastTranscript && (
          <div className="helper" style={{ marginTop: 8 }}>
            Last transcript: <span style={{ color: 'var(--fg)' }}>{lastTranscript}</span>
          </div>
        )}
      </div>
    </>
  );
}
