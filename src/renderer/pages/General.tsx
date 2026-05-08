import { useEffect, useState } from 'react';
import type { AudioInputDevice, Settings } from '../../shared/types';
import { UI_LANGS, type UiLang } from '../../shared/i18n';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function GeneralPage({ settings, update }: Props): JSX.Element {
  const { t, setLang } = useI18n();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState('');
  const [testError, setTestError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);

  useEffect(() => {
    void window.windvoice.hasApiKey().then(setHasKey);
  }, []);

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

  useEffect(() => {
    void enumerateMicrophones().then(setDevices);
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

  async function refreshDevices(): Promise<void> {
    setDevices(await enumerateMicrophones());
  }

  return (
    <>
      <h2>{t('general.title')}</h2>

      <label className="field">
        <span className="field-label">{t('general.apiKey')}</span>
        <div className="row">
          <input
            type="password"
            placeholder={hasKey ? t('general.apiKeyPlaceholderHas') : t('general.apiKeyPlaceholderEmpty')}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            autoComplete="off"
          />
          <button
            className="primary"
            onClick={() => void saveKey()}
            disabled={saving || !keyInput.trim()}
          >
            {saving ? t('general.saving') : t('general.save')}
          </button>
        </div>
        <div className="helper">
          {t('general.apiKeyHelper')}
          {savedAt && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>{t('general.saved')}</span>}
        </div>
      </label>

      <label className="field">
        <span className="field-label">{t('general.uiLanguage')}</span>
        <select
          value={settings.ui.uiLanguage}
          onChange={(e) => void setLang(e.target.value as UiLang)}
        >
          {UI_LANGS.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">{t('general.microphone')}</span>
        <div className="row">
          <select
            style={{ flex: 1 }}
            value={settings.audio.device}
            onChange={(e) =>
              void update({
                audio: { ...settings.audio, device: e.target.value }
              })
            }
          >
            <option value="default">{t('general.microphoneDefault')}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
            ))}
          </select>
          <button
            onClick={() => void refreshDevices()}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--fg-dim)',
              padding: '6px 12px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12
            }}
          >
            {t('general.microphoneRefresh')}
          </button>
        </div>
      </label>

      <label className="field">
        <span className="field-label">{t('general.language')}</span>
        <select
          value={settings.language}
          onChange={(e) => void update({ language: e.target.value })}
        >
          <option value="auto">{t('general.languageAuto')}</option>
          <option value="ja">{t('general.languageJa')}</option>
          <option value="en">{t('general.languageEn')}</option>
          <option value="zh">{t('general.languageZh')}</option>
          <option value="ko">{t('general.languageKo')}</option>
        </select>
      </label>

      <label className="field">
        <span className="field-label">{t('general.insertion')}</span>
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
          <option value="paste">{t('general.insertionPaste')}</option>
          <option value="type" disabled>{t('general.insertionType')}</option>
        </select>
      </label>

      <label className="field">
        <span className="field-label">{t('general.formatter')}</span>
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
          <span>{t('general.formatterEnable')}</span>
        </div>
        <div className="helper">{t('general.formatterHelper')}</div>
      </label>

      <div className="field" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.feedback')}</span>
        <div className="row">
          <input
            type="checkbox"
            checked={settings.ui.overlayEnabled}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, overlayEnabled: e.target.checked } })
            }
          />
          <span>{t('general.showOverlay')}</span>
        </div>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.showOverlayHelper')}</div>

        <div className="row">
          <input
            type="checkbox"
            checked={settings.ui.soundCuesEnabled}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, soundCuesEnabled: e.target.checked } })
            }
          />
          <span>{t('general.soundCues')}</span>
        </div>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.soundCuesHelper')}</div>

        <div className="row">
          <input
            type="checkbox"
            checked={settings.ui.duckOtherAudio}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, duckOtherAudio: e.target.checked } })
            }
          />
          <span>{t('general.duckAudio')}</span>
        </div>
        <div className="helper">{t('general.duckAudioHelper')}</div>
      </div>

      <div className="field" style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.diagnostics')}</span>
        <div className="row">
          <button className="primary" onClick={() => void runTest()} disabled={testing || !hasKey}>
            {testing ? t('general.testDictationRecording') : t('general.testDictation')}
          </button>
          <span className="helper" style={{ marginTop: 0 }}>
            {t('general.testDictationHelper')}
          </span>
        </div>
        {testError && (
          <div className="helper" style={{ color: 'var(--error)', marginTop: 8 }}>
            {testError}
          </div>
        )}
        {lastTranscript && (
          <div className="helper" style={{ marginTop: 8 }}>
            {t('general.lastTranscript')} <span style={{ color: 'var(--fg)' }}>{lastTranscript}</span>
          </div>
        )}
      </div>
    </>
  );
}

async function enumerateMicrophones(): Promise<AudioInputDevice[]> {
  try {
    // Ensure permission so labels are exposed.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    /* if permission denied, labels will be empty */
  }
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }));
}
