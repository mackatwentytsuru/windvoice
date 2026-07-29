// Wayland keystroke injection via the XDG Desktop Portal RemoteDesktop
// interface (org.freedesktop.portal.RemoteDesktop).
//
// Why this exists: XTest (uIOhook.keyTap) only reaches XWayland clients.
// Under GNOME/KDE Wayland the focused app is usually Wayland-native, so the
// synthesized Ctrl+V would silently vanish. The RemoteDesktop portal is the
// sanctioned way for a host app to inject input on Wayland: the compositor
// shows a consent dialog once, we persist the `restore_token` (persist_mode
// 2 = "until explicitly revoked"), and every later launch reconnects
// silently.
//
// Implemented against the low-level dbus-next Message API rather than
// ProxyObject introspection — the portal's Request/Response pattern needs a
// match rule registered BEFORE the method call returns, which the high-level
// API cannot guarantee.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import * as dbus from 'dbus-next';
import { debug } from '@main/debug';
import { sleep } from '@main/util/sleep';

const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const RD_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';

/** DeviceType bitmask — we only ever need the keyboard. */
const DEVICE_KEYBOARD = 1;
/** persist_mode 2: grant persists until the user revokes it in Settings. */
const PERSIST_UNTIL_REVOKED = 2;

/** Linux input-event-codes.h values used for the paste chord. */
const KEY_LEFTCTRL = 29;
const KEY_V = 47;

const TOKEN_FILE = '.portal-remotedesktop.json';
/** How long to wait for the user to answer the one-time consent dialog. */
const START_DIALOG_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Compute the handle path the portal will use for a request created with
 * `handle_token`, per the org.freedesktop.portal.Request spec:
 * /org/freedesktop/portal/desktop/request/<SENDER>/<TOKEN> where <SENDER>
 * is the caller's unique name with the leading ':' stripped and '.'
 * replaced by '_'. Exported for tests.
 */
export function requestPathFor(uniqueName: string, handleToken: string): string {
  const sender = uniqueName.replace(/^:/, '').replace(/\./g, '_');
  return `${PORTAL_PATH}/request/${sender}/${handleToken}`;
}

interface PortalResponse {
  code: number;
  results: Record<string, dbus.Variant | unknown>;
}

function tokenFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), TOKEN_FILE);
  } catch {
    return null;
  }
}

function loadRestoreToken(): string | null {
  const fp = tokenFilePath();
  if (!fp) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

function saveRestoreToken(token: string | null): void {
  const fp = tokenFilePath();
  if (!fp) return;
  try {
    if (token === null) {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } else {
      fs.writeFileSync(fp, JSON.stringify({ token }), { mode: 0o600 });
    }
  } catch (err) {
    debug('DICTATION', `portal: persist restore_token failed: ${err}`);
  }
}

function variantValue(v: unknown): unknown {
  return v instanceof dbus.Variant ? v.value : v;
}

class PortalRemoteDesktop {
  private bus: dbus.MessageBus | null = null;
  private sessionHandle: string | null = null;
  private ensurePromise: Promise<boolean> | null = null;
  private tokenCounter = 0;
  /** Set when the consent dialog was denied — don't re-prompt every paste. */
  private deniedByUser = false;

  /**
   * True once a live portal session exists. Callers can use this to decide
   * whether to fall back to the XTest path without waiting on D-Bus.
   */
  isReady(): boolean {
    return this.sessionHandle !== null;
  }

  wasDenied(): boolean {
    return this.deniedByUser;
  }

  /**
   * Establish (or re-establish) the RemoteDesktop session. Idempotent and
   * coalescing — concurrent callers share one attempt. Returns true when a
   * session is available. Shows the compositor consent dialog on the very
   * first run; afterwards the persisted restore_token reconnects silently.
   */
  ensureSession(): Promise<boolean> {
    if (this.sessionHandle !== null) return Promise.resolve(true);
    if (this.deniedByUser) return Promise.resolve(false);
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.createSession()
      .catch((err) => {
        debug('DICTATION', `portal: session setup failed: ${err}`);
        return false;
      })
      .finally(() => {
        this.ensurePromise = null;
      });
    return this.ensurePromise;
  }

  /** Inject Ctrl+V into the focused window via the compositor. */
  async pasteCtrlV(): Promise<void> {
    const ok = await this.ensureSession();
    if (!ok || !this.bus || !this.sessionHandle) {
      throw new Error(
        this.deniedByUser
          ? 'RemoteDesktop portal access was denied — enable it in system Settings > Applications, then restart WindVoice'
          : 'RemoteDesktop portal session unavailable'
      );
    }
    await this.notifyKey(KEY_LEFTCTRL, true);
    await this.notifyKey(KEY_V, true);
    // A brief hold between press and release keeps slow toolkit event loops
    // from coalescing the chord away; matches typical wtype/ydotool pacing.
    await sleep(8);
    await this.notifyKey(KEY_V, false);
    await this.notifyKey(KEY_LEFTCTRL, false);
  }

  private async notifyKey(keycode: number, down: boolean): Promise<void> {
    if (!this.bus || !this.sessionHandle) throw new Error('portal session not ready');
    const reply = await this.bus.call(
      new dbus.Message({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: RD_IFACE,
        member: 'NotifyKeyboardKeycode',
        signature: 'oa{sv}iu',
        body: [this.sessionHandle, {}, keycode, down ? 1 : 0]
      })
    );
    void reply;
  }

  private async connect(): Promise<dbus.MessageBus> {
    if (this.bus) return this.bus;
    const bus = dbus.sessionBus();
    bus.on('error', (err) => debug('DICTATION', `portal: bus error: ${err}`));
    // Force the Hello round-trip so `bus.name` (our unique name, needed to
    // predict request object paths) is populated.
    await bus.call(
      new dbus.Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus.Peer',
        member: 'Ping'
      })
    );
    // Watch for the portal closing our session (user revoked the grant,
    // compositor restart). Next paste attempt recreates it.
    await this.addMatch(
      bus,
      `type='signal',interface='${SESSION_IFACE}',member='Closed'`
    );
    bus.on('message', (msg) => {
      if (
        msg.interface === SESSION_IFACE &&
        msg.member === 'Closed' &&
        msg.path === this.sessionHandle
      ) {
        debug('DICTATION', 'portal: session closed by compositor');
        this.sessionHandle = null;
      }
    });
    this.bus = bus;
    return bus;
  }

  private async addMatch(bus: dbus.MessageBus, rule: string): Promise<void> {
    await bus.call(
      new dbus.Message({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [rule]
      })
    );
  }

  /**
   * Call a portal method that follows the Request/Response pattern and wait
   * for the matching org.freedesktop.portal.Request Response signal.
   */
  private async portalRequest(
    bus: dbus.MessageBus,
    member: string,
    signature: string,
    body: unknown[],
    options: Record<string, dbus.Variant>,
    timeoutMs: number
  ): Promise<PortalResponse> {
    const handleToken = `windvoice_${process.pid}_${++this.tokenCounter}`;
    options['handle_token'] = new dbus.Variant('s', handleToken);
    const uniqueName = (bus as unknown as { name: string | null }).name;
    if (!uniqueName) throw new Error('portal: bus unique name unknown');
    const expectedPath = requestPathFor(uniqueName, handleToken);
    await this.addMatch(
      bus,
      `type='signal',interface='${REQUEST_IFACE}',member='Response',path='${expectedPath}'`
    );

    const responsePromise = new Promise<PortalResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.removeListener('message', onMessage);
        reject(new Error(`portal: ${member} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onMessage = (msg: dbus.Message): void => {
        if (msg.interface !== REQUEST_IFACE || msg.member !== 'Response') return;
        if (msg.path !== expectedPath) return;
        clearTimeout(timer);
        bus.removeListener('message', onMessage);
        const [code, results] = msg.body as [number, Record<string, unknown>];
        resolve({ code: Number(code), results: results ?? {} });
      };
      bus.on('message', onMessage);
    });
    // Mark the response promise as observed. If the method call below throws
    // (e.g. "Portal operation not allowed"), portalRequest rethrows before
    // anyone awaits responsePromise — its later timeout rejection would then
    // fire as an unhandledRejection. The caller still receives rejections
    // through the returned promise as usual.
    responsePromise.catch(() => undefined);

    const reply = await bus.call(
      new dbus.Message({
        destination: PORTAL_DEST,
        path: PORTAL_PATH,
        interface: RD_IFACE,
        member,
        signature,
        body: [...body, options]
      })
    );
    // Some portal backends return a request path that differs from the
    // token-derived one (older xdg-desktop-portal). The spec says clients
    // should then listen on the returned path — with a modern portal the
    // paths match, so treat a mismatch as best-effort and keep waiting on
    // the predicted path (worst case: timeout → fallback path engages).
    const returnedPath = reply?.body?.[0] as string | undefined;
    if (returnedPath && returnedPath !== expectedPath) {
      debug('DICTATION', `portal: request path mismatch (${returnedPath} != ${expectedPath})`);
    }
    return responsePromise;
  }

  private async createSession(): Promise<boolean> {
    const bus = await this.connect();

    // 1. CreateSession
    const sessionToken = `windvoice_s_${process.pid}_${++this.tokenCounter}`;
    const create = await this.portalRequest(
      bus,
      'CreateSession',
      'a{sv}',
      [],
      { session_handle_token: new dbus.Variant('s', sessionToken) },
      REQUEST_TIMEOUT_MS
    );
    if (create.code !== 0) throw new Error(`CreateSession response code ${create.code}`);
    const sessionHandle = String(variantValue(create.results['session_handle']));
    if (!sessionHandle || sessionHandle === 'undefined') {
      throw new Error('CreateSession returned no session_handle');
    }

    // 2. SelectDevices (keyboard only, persistent grant, restore if possible)
    const selectOptions: Record<string, dbus.Variant> = {
      types: new dbus.Variant('u', DEVICE_KEYBOARD),
      persist_mode: new dbus.Variant('u', PERSIST_UNTIL_REVOKED)
    };
    const restoreToken = loadRestoreToken();
    if (restoreToken) selectOptions['restore_token'] = new dbus.Variant('s', restoreToken);
    const select = await this.portalRequest(
      bus,
      'SelectDevices',
      'oa{sv}',
      [sessionHandle],
      selectOptions,
      REQUEST_TIMEOUT_MS
    );
    if (select.code !== 0) throw new Error(`SelectDevices response code ${select.code}`);

    // 3. Start — this is where the consent dialog appears (first run only).
    const start = await this.portalRequest(
      bus,
      'Start',
      'osa{sv}',
      [sessionHandle, ''],
      {},
      START_DIALOG_TIMEOUT_MS
    );
    if (start.code !== 0) {
      // code 1 = user cancelled, 2 = other error. A stale restore_token can
      // also surface as failure — drop it so the next attempt re-prompts.
      saveRestoreToken(null);
      if (start.code === 1) {
        this.deniedByUser = true;
        debug('DICTATION', 'portal: user denied the RemoteDesktop consent dialog');
      }
      throw new Error(`Start response code ${start.code}`);
    }
    const newToken = variantValue(start.results['restore_token']);
    if (typeof newToken === 'string' && newToken.length > 0) saveRestoreToken(newToken);

    this.sessionHandle = sessionHandle;
    debug('DICTATION', `portal: RemoteDesktop session ready (${sessionHandle})`);
    return true;
  }
}

export const portalRemoteDesktop = new PortalRemoteDesktop();
