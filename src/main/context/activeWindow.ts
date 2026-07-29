// Cross-platform foreground window detector. Wraps `get-windows` with a
// short TTL cache (so we don't spawn a helper process per delta event) and
// a hard timeout (so a hung helper never stalls the dictation pipeline).
//
// Returns `null` whenever the foreground window can't be determined for any
// reason — missing accessibility permission on macOS, an empty desktop on
// Windows, the helper binary throwing, etc. Callers should treat null as
// "no signal" and continue without app-aware behavior.

import { activeWindow } from 'get-windows';
import { debug } from '@main/debug';
import { isWaylandSession } from '@main/linux/wayland';

export interface ActiveWindowInfo {
  /**
   * Window title. SECURITY: never embed this verbatim into LLM prompts —
   * titles often contain PII (filenames, email subjects, URLs). Use only
   * for app-aware UX (e.g. matching against a user-defined rule).
   */
  title: string;
  app: string;
}

/**
 * Subset safe for LLM prompts: app name only, no title. Use this type
 * (not `ActiveWindowInfo`) anywhere that flows into a prompt.
 */
export interface ActiveWindowPromptInfo {
  readonly app: string;
}

export function toPromptInfo(info: ActiveWindowInfo | null): ActiveWindowPromptInfo | null {
  return info ? { app: info.app } : null;
}

const CACHE_TTL_MS = 500;
const HARD_TIMEOUT_MS = 1500;

interface CacheSlot {
  expiresAt: number;
  value: ActiveWindowInfo | null;
}

let cache: CacheSlot | null = null;

function fromResult(result: unknown): ActiveWindowInfo | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { title?: unknown; owner?: { name?: unknown } };
  const title = typeof r.title === 'string' ? r.title : '';
  const ownerName = r.owner && typeof r.owner.name === 'string' ? r.owner.name : '';
  if (!title && !ownerName) return null;
  return { title, app: ownerName };
}

type Settled<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error' };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: 'ok', value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        debug('DICTATION', `activeWindow() threw: ${msg}`);
        resolve({ kind: 'error' });
      }
    );
  });
}

export async function getActiveWindow(): Promise<ActiveWindowInfo | null> {
  // get-windows' Linux backend shells out to xprop/xwininfo. Those tools
  // cannot see native Wayland windows, so skip doomed helper processes.
  if (isWaylandSession()) return null;

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }

  const settled = await withTimeout(
    Promise.resolve().then(() => activeWindow()),
    HARD_TIMEOUT_MS
  );

  if (settled.kind === 'timeout') {
    debug('DICTATION', `activeWindow() timed out after ${HARD_TIMEOUT_MS}ms`);
    // Return whatever we have cached (even if expired); otherwise null.
    // Don't refresh the cache TTL — we don't know the real foreground state.
    return cache?.value ?? null;
  }

  if (settled.kind === 'error') {
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, value: null };
    return null;
  }

  const info = fromResult(settled.value);
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, value: info };
  return info;
}

/** Test-only: drop the cached value so the next call refetches. */
export function __resetActiveWindowCacheForTests(): void {
  cache = null;
}
