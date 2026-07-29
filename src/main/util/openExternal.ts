import { shell } from 'electron';
import { debug } from '@main/debug';

const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'x-apple.systempreferences:',
  'https:',
  'mailto:'
]);

/**
 * Open only explicitly allowed external URL schemes. This keeps release and
 * issue-page links from becoming a generic shell-protocol launcher.
 */
export async function openExternalSafe(url: string): Promise<boolean> {
  const lower = url.toLowerCase();
  if (![...ALLOWED_EXTERNAL_SCHEMES].some((scheme) => lower.startsWith(scheme))) {
    debug('MAIN', `openExternal blocked disallowed scheme: ${url}`);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug('MAIN', `openExternal failed: ${message}`);
    return false;
  }
}
