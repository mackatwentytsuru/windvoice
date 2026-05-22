import { useEffect, useState } from 'react';
import type { UpdaterState } from '../shared/ipc';
import { useI18n } from './useI18n';

/**
 * Surfaces auto-updater state. The updater never downloads or installs on
 * its own (builds are unsigned — see main/updater) so this banner is the
 * only path to an update: it shows an explicit "Download" then "Restart"
 * button, each driven by a deliberate user click.
 */
export function UpdaterBanner(): JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<UpdaterState>({ phase: 'idle' });
  const [busy, setBusy] = useState(false);

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
      label: t('general.updateDownload'),
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
