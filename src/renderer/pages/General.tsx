import { useEffect, useState } from 'react';
import type { AudioInputDevice, Settings } from '../../shared/types';
import type { ErrorReportPreview, UpdaterState } from '../../shared/ipc';
import { UI_LANGS, type UiLang } from '../../shared/i18n';
import { useI18n } from '../useI18n';

interface Props {
  settings: Settings;
  update: (partial: Partial<Settings>) => Promise<void>;
}

export function GeneralPage({ settings, update }: Props): JSX.Element {
  const { t, tPlatform, setLang } = useI18n();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState('');
  const [testError, setTestError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updaterState, setUpdaterState] = useState<UpdaterState>({ phase: 'idle' });
  const [reportPreview, setReportPreview] = useState<ErrorReportPreview | null>(null);
  const [showReportPreview, setShowReportPreview] = useState(false);
  const [reportResult, setReportResult] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  async function checkForUpdate(): Promise<void> {
    setCheckingUpdate(true);
    setUpdateMsg(t('general.updateChecking'));
    try {
      const s = await window.windvoice.checkForUpdate();
      setUpdaterState(s);
      if (s.phase === 'not-available') setUpdateMsg(t('general.updateUpToDate'));
      else if (s.phase === 'available') setUpdateMsg(`${t('general.updateAvailable')} (v${s.version})`);
      else if (s.phase === 'error') setUpdateMsg(`${t('general.updateError')}: ${s.message}`);
      else setUpdateMsg(null);
    } catch (err) {
      setUpdateMsg(`${t('general.updateError')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    void window.windvoice.hasApiKey().then(setHasKey);
  }, []);

  useEffect(() => {
    void window.windvoice
      .getUpdaterState()
      .then(setUpdaterState)
      .catch(() => undefined);
    const offUpdater = window.windvoice.onUpdaterState(setUpdaterState);
    void window.windvoice
      .getErrorReportPreview()
      .then(setReportPreview)
      .catch(() => undefined);
    const offReport = window.windvoice.onErrorReportPending(setReportPreview);
    return () => {
      offUpdater();
      offReport();
    };
  }, []);

  async function runUpdateAction(): Promise<void> {
    if (updaterState.phase === 'available') {
      setUpdaterState(await window.windvoice.downloadUpdate());
    } else if (updaterState.phase === 'downloaded') {
      await window.windvoice.restartToUpdate();
    } else if (updaterState.phase === 'error') {
      if (updaterState.retry === 'download') {
        setUpdaterState(await window.windvoice.downloadUpdate());
      } else {
        await checkForUpdate();
      }
    }
  }

  async function setErrorReporting(enabled: boolean): Promise<void> {
    await update({
      ui: {
        ...settings.ui,
        errorReporting: enabled,
        errorReportingConsent: enabled ? 'enabled' : 'disabled',
        errorReportingPrompted: true
      }
    });
    if (!enabled) {
      setReportPreview(await window.windvoice.discardErrorReport(true));
      setShowReportPreview(false);
    }
  }

  async function sendReport(): Promise<void> {
    setReportBusy(true);
    setReportResult(null);
    try {
      await setErrorReporting(true);
      const result = await window.windvoice.sendErrorReport();
      if (result.status === 'sent') setReportResult(t('general.reportSent'));
      else if (result.status === 'manual') setReportResult(t('general.reportManual'));
      else if (result.status === 'rate-limited') setReportResult(t('general.reportRateLimited'));
      else if (result.status === 'failed') setReportResult(`${t('general.reportFailed')}: ${result.message}`);
      setReportPreview(await window.windvoice.getErrorReportPreview());
      setShowReportPreview(false);
    } finally {
      setReportBusy(false);
    }
  }

  async function discardReport(): Promise<void> {
    setReportBusy(true);
    try {
      const undecided = settings.ui.errorReportingConsent === 'undecided';
      setReportPreview(await window.windvoice.discardErrorReport(undecided));
      if (undecided) {
        await update({
          ui: {
            ...settings.ui,
            errorReporting: false,
            errorReportingConsent: 'disabled',
            errorReportingPrompted: true
          }
        });
      }
      setShowReportPreview(false);
      setReportResult(t('general.reportDiscarded'));
    } finally {
      setReportBusy(false);
    }
  }

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
    void enumerateMicrophones()
      .then((devs) => {
        setDevices(devs);
        setDeviceError(null);
      })
      .catch((err) => setDeviceError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return;
    setSaving(true);
    setApiKeyError(null);
    try {
      await window.windvoice.setApiKey(keyInput.trim());
      setHasKey(true);
      setKeyInput('');
      setSavedAt(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/invalid/i.test(message)) {
        setApiKeyError(t('error.apiKeyInvalid'));
      } else if (/keytar|keychain|credential|keyring|secure[- ]?store/i.test(message)) {
        setApiKeyError(t('error.secureStoreUnavailable'));
      } else {
        setApiKeyError(message);
      }
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
    setDeviceError(null);
    try {
      setDevices(await enumerateMicrophones());
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <h2>{t('general.title')}</h2>

      <div className="field">
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
          {tPlatform('general.apiKeyHelper')}
          {savedAt && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>{t('general.saved')}</span>}
        </div>
        {apiKeyError && (
          <div className="helper" style={{ color: 'var(--error)', marginTop: 4 }} role="alert">
            {apiKeyError}
          </div>
        )}
      </div>

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
            className="button-secondary"
            onClick={() => void refreshDevices()}
          >
            {t('general.microphoneRefresh')}
          </button>
        </div>
        {deviceError && (
          <div className="helper" style={{ color: 'var(--error)' }} role="alert">
            {deviceError}
          </div>
        )}
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

      <div className="field">
        <span className="field-label">{t('general.formatter')}</span>
        <label className="row" style={{ cursor: 'pointer' }}>
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
        </label>
        <div className="helper">{t('general.formatterHelper')}</div>
      </div>

      <div className="field" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.feedback')}</span>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.overlayEnabled}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, overlayEnabled: e.target.checked } })
            }
          />
          <span>{t('general.showOverlay')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.showOverlayHelper')}</div>

        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.soundCuesEnabled}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, soundCuesEnabled: e.target.checked } })
            }
          />
          <span>{t('general.soundCues')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.soundCuesHelper')}</div>

        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.duckOtherAudio}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, duckOtherAudio: e.target.checked } })
            }
          />
          <span>{t('general.duckAudio')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.duckAudioHelper')}</div>

        <label className="field-label" htmlFor="insertion-method">
          {t('general.insertion')}
        </label>
        <select
          id="insertion-method"
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
          <option value="paste">{tPlatform('general.insertionPaste')}</option>
          <option value="type">{t('general.insertionType')}</option>
        </select>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.insertionTypeHelper')}</div>

        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.insertion.streaming}
            onChange={(e) =>
              void update({
                insertion: { ...settings.insertion, streaming: e.target.checked }
              })
            }
          />
          <span>{t('general.streaming')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.streamingHelper')}</div>

        <label className="field-label" htmlFor="paste-compat">
          {t('general.pasteCompat')}
        </label>
        <select
          id="paste-compat"
          value={settings.insertion.pasteCompatibility}
          onChange={(e) =>
            void update({
              insertion: {
                ...settings.insertion,
                pasteCompatibility: e.target.value as 'fast' | 'balanced' | 'safe'
              }
            })
          }
        >
          <option value="fast">{t('general.pasteCompatFast')}</option>
          <option value="balanced">{t('general.pasteCompatBalanced')}</option>
          <option value="safe">{t('general.pasteCompatSafe')}</option>
        </select>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.pasteCompatHelper')}</div>

        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.insertion.excludeFromClipboardHistory}
            onChange={(e) =>
              void update({
                insertion: {
                  ...settings.insertion,
                  excludeFromClipboardHistory: e.target.checked
                }
              })
            }
          />
          <span>{t('general.excludeClipboardHistory')}</span>
        </label>
        <div className="helper">{t('general.excludeClipboardHistoryHelper')}</div>
      </div>

      <div className="field" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.system')}</span>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.autoLaunch}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, autoLaunch: e.target.checked } })
            }
          />
          <span>{t('general.autoLaunch')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.autoLaunchHelper')}</div>
      </div>

      <div className="field" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.updates')}</span>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.autoUpdate}
            onChange={(e) =>
              void update({ ui: { ...settings.ui, autoUpdate: e.target.checked } })
            }
          />
          <span>{t('general.autoUpdate')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.autoUpdateHelper')}</div>
        <div className="helper" style={{ marginBottom: 8 }}>
          {t('general.currentVersion')}: {updaterState.currentVersion ?? '—'}
        </div>
        <div className="helper" style={{ marginBottom: 8 }} role="status">
          {updaterStatusLabel(updaterState, t)}
        </div>
        <div className="row">
          <button onClick={() => void checkForUpdate()} disabled={checkingUpdate}>
            {t('general.checkForUpdate')}
          </button>
          {(updaterState.phase === 'available' ||
            updaterState.phase === 'downloaded' ||
            updaterState.phase === 'error') && (
            <button className="primary" onClick={() => void runUpdateAction()}>
              {updaterActionLabel(updaterState, t)}
            </button>
          )}
          {updateMsg && (
            <span className="helper" style={{ marginTop: 0 }}>{updateMsg}</span>
          )}
        </div>
      </div>

      <div className="field" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <span className="field-label">{t('general.errorReports')}</span>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={settings.ui.errorReporting}
            onChange={(e) => void setErrorReporting(e.target.checked)}
          />
          <span>{t('general.errorReporting')}</span>
        </label>
        <div className="helper" style={{ marginBottom: 8 }}>{t('general.errorReportingHelper')}</div>
        {reportPreview && (
          <div
            role="status"
            style={{
              padding: 10,
              border: '1px solid var(--border)',
              borderRadius: 6,
              marginTop: 8
            }}
          >
            <div style={{ marginBottom: 8 }}>
              {settings.ui.errorReportingConsent === 'undecided'
                ? t('general.reportConsentQuestion')
                : t('general.reportPending')}
            </div>
            <button onClick={() => setShowReportPreview((shown) => !shown)}>
              {t('general.reportPreview')}
            </button>
            {showReportPreview && (
              <>
                <div className="helper" style={{ marginTop: 8 }}>{reportPreview.title}</div>
                <textarea
                  readOnly
                  value={reportPreview.body}
                  rows={12}
                  style={{ width: '100%', marginTop: 8, fontFamily: 'monospace' }}
                  aria-label={t('general.reportPreview')}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="primary" disabled={reportBusy} onClick={() => void sendReport()}>
                    {t('general.reportSend')}
                  </button>
                  <button disabled={reportBusy} onClick={() => void discardReport()}>
                    {t('general.reportDiscard')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {reportResult && <div className="helper" style={{ marginTop: 8 }}>{reportResult}</div>}
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

function updaterStatusLabel(
  state: UpdaterState,
  t: (key: string) => string
): string {
  switch (state.phase) {
    case 'idle':
      return t('general.updateIdle');
    case 'checking':
      return t('general.updateChecking');
    case 'not-available':
      return t('general.updateUpToDate');
    case 'available':
      return `${t('general.updateAvailable')} ${state.version}`;
    case 'downloading':
      return `${t('general.updateDownloading')} ${state.percent}%`;
    case 'downloaded':
      return `${t('general.updateDownloaded')} (${state.version})`;
    case 'error':
      return `${t('general.updateError')}: ${state.message}`;
  }
}

function updaterActionLabel(
  state: Extract<UpdaterState, { phase: 'available' | 'downloaded' | 'error' }>,
  t: (key: string) => string
): string {
  if (state.phase === 'downloaded') return t('general.updateRestart');
  if (state.phase === 'error') return t('general.updateRetry');
  return state.delivery === 'manual'
    ? t('general.updateOpenRelease')
    : t('general.updateDownload');
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
