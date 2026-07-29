import { useEffect, useState } from 'react';
import type { UpdaterState } from '../shared/ipc';
import { useI18n } from './useI18n';

/**
 * `busy` guards the action button between the user's click and the next
 * updater state broadcast. It lives in module scope (mirrored into
 * component state below) so a REMOUNT within the same renderer — tab
 * switches, React 18 StrictMode double-mount — restores an in-flight
 * click instead of silently re-enabling the button.
 *
 * Known limitation (deliberate — avoids adding a new IPC channel): if the
 * settings WINDOW itself is destroyed and recreated (close → reopen from
 * the tray), the renderer process and this module scope die with it. That
 * is acceptable because main broadcasts `downloading` synchronously at
 * the start of UPDATER_DOWNLOAD (before any await — see main/updater),
 * so the recreated window re-derives the correct phase from the
 * UPDATER_LAST_STATE query on mount; only the few-millisecond
 * click→broadcast race is unrecoverable, and re-clicking Download /
 * Restart is idempotent on the main side.
 */
let lastKnownBusy = false;

/**
 * Mirrors the resident notification/tray flow inside Settings. The updater
 * never downloads on a check; every download/restart remains user initiated.
 */
export function UpdaterBanner(): JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<UpdaterState>({ phase: 'idle' });
  const [busy, setBusyState] = useState(lastKnownBusy);

  // Single funnel for busy updates: keep the module-scope mirror and the
  // rendered state in lockstep so the next mount starts from the truth.
  function setBusy(value: boolean): void {
    lastKnownBusy = value;
    setBusyState(value);
  }

  useEffect(() => {
    // On an unsigned macOS build the auto-updater is never initialized,
    // so its IPC handlers are not registered and this invoke rejects.
    // Swallow it: the banner simply stays idle (renders nothing) rather
    // than producing an unhandled promise rejection on every open.
    void window.windvoice
      .getUpdaterState()
      .then(setState)
      .catch(() => undefined);
    const off = window.windvoice.onUpdaterState((s) => {
      setState(s);
      setBusy(false);
    });
    return off;
  }, []);

  // Don't nag: idle / not-available / checking produce no banner. The
  // General page's "check" button gives explicit feedback for those.
  if (state.phase === 'idle' || state.phase === 'not-available' || state.phase === 'checking') {
    return null;
  }

  let message = '';
  let action: { label: string; run: () => void } | null = null;

  if (state.phase === 'available') {
    message = `${t('general.updateAvailable')} (v${state.version})`;
    action = {
      label:
        state.delivery === 'manual'
          ? t('general.updateOpenRelease')
          : t('general.updateDownload'),
      run: () => {
        setBusy(true);
        // Clear `busy` when the call settles even if no further state
        // broadcast arrives (a rejected promise / dropped event would
        // otherwise leave the button disabled forever).
        void window.windvoice.downloadUpdate().finally(() => setBusy(false));
      }
    };
  } else if (state.phase === 'downloading') {
    message = `${t('general.updateDownloading')} ${state.percent}%`;
  } else if (state.phase === 'downloaded') {
    message = `${t('general.updateDownloaded')} (v${state.version})`;
    action = {
      label: t('general.updateRestart'),
      run: () => {
        setBusy(true);
        void window.windvoice.restartToUpdate().finally(() => setBusy(false));
      }
    };
  } else if (state.phase === 'error') {
    message = `${t('general.updateError')}: ${state.message}`;
  }

  const isError = state.phase === 'error';

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        marginBottom: 16,
        border: `1px solid ${isError ? 'var(--error)' : 'var(--border)'}`,
        borderRadius: 6,
        background: isError
          ? 'color-mix(in oklab, var(--error) 12%, transparent)'
          : 'color-mix(in oklab, var(--accent, #4f8cff) 12%, transparent)',
        fontSize: 13,
        lineHeight: 1.4
      }}
    >
      <span style={{ flex: 1, wordBreak: 'break-word', color: isError ? 'var(--error)' : 'inherit' }}>
        {message}
      </span>
      {action && (
        <button type="button" onClick={action.run} disabled={busy}>
          {action.label}
        </button>
      )}
    </div>
  );
}
