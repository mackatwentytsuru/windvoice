#!/usr/bin/env python3
"""WindVoice Wayland portal sidecar.

Owns an XDG Desktop Portal RemoteDesktop session with the Clipboard
capability and exposes a newline-delimited JSON protocol over stdio.

Why this exists: on Wayland a background app cannot set the clipboard for
Wayland-native windows (selection ownership requires keyboard focus, and
GNOME only bridges an XWayland client's selection while that client is
focused). The portal Clipboard interface is the sanctioned escape hatch:
a RemoteDesktop session that requested the clipboard capability may claim
the selection at any time and serve the data on demand. The portal APIs
hand data over as UNIX file descriptors, which the pure-JS D-Bus client in
the main process cannot receive — PyGObject (python3-gi, preinstalled on
every GNOME/KDE system) handles them natively, so this small sidecar does.

Protocol (one JSON object per line):
  stdin:
    {"id":1,"op":"paste","text":"...","restore":true,
     "settleMs":150,"restoreMs":1500}
        Snapshot current selection (if restore), claim it with text, inject
        Ctrl+V, wait, restore the old selection. Replies when finished.
    {"id":2,"op":"snapshot"}            -> {"id":2,"ok":true,"text":...|null}
    {"id":3,"op":"set_selection","text":"..."}
    {"id":4,"op":"key_paste"}           inject Ctrl+V only
    {"id":5,"op":"ping"}
  stdout:
    {"event":"ready","clipboard":true}  session established
    {"event":"failed","code":N,"denied":bool}
    {"event":"closed"}                  compositor closed the session
    {"id":N,"ok":true,...} | {"id":N,"ok":false,"error":"..."}
"""
import json
import os
import sys
import threading
import time

import gi  # noqa: E402
from gi.repository import GLib, Gio  # noqa: E402

PORTAL = 'org.freedesktop.portal.Desktop'
PPATH = '/org/freedesktop/portal/desktop'
RD = 'org.freedesktop.portal.RemoteDesktop'
CLIP = 'org.freedesktop.portal.Clipboard'
REQ = 'org.freedesktop.portal.Request'
SESSION_IFACE = 'org.freedesktop.portal.Session'
KEY_LEFTCTRL, KEY_V = 29, 47
MIME_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'TEXT', 'STRING']

TOKEN_FILE = sys.argv[1] if len(sys.argv) > 1 else None

out_lock = threading.Lock()


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
        sys.stdout.flush()


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
unique = bus.get_unique_name()
sender_token = unique[1:].replace('.', '_')
counter = 0
state = {
    'session': None,
    'clipboard': False,
    # Text served for SelectionTransfer requests while we own the selection.
    'selection_text': '',
    # Mime types of the current FOREIGN selection owner (None = unknown/none,
    # [] = we own it or it was cleared). Maintained from
    # SelectionOwnerChanged. Consulted before SelectionRead because GNOME
    # 46's portal backend hard-crashes (GLib assertion → abort, then the
    # main portal SEGVs) when SelectionRead runs with no selection owner —
    # reproduced live on Ubuntu 24.04. Never read blind.
    'foreign_mimes': None,
}
state_lock = threading.Lock()


def call(iface, method, variant):
    return bus.call_sync(PORTAL, PPATH, iface, method, variant, None, 0, -1, None)


def portal_request(iface, method, build_args, timeout_s=120):
    """Blocking portal Request/Response round trip (worker thread safe)."""
    global counter
    counter += 1
    token = f'wv_{os.getpid()}_{counter}'
    req_path = f'{PPATH}/request/{sender_token}/{token}'
    done = threading.Event()
    result = {}

    def on_signal(conn, sender, path, siface, member, params):
        code, results = params.unpack()
        result['code'] = code
        result['results'] = results
        done.set()

    sub = bus.signal_subscribe(None, REQ, 'Response', req_path, None, 0, on_signal)
    try:
        call(iface, method, build_args(token))
        if not done.wait(timeout_s):
            raise TimeoutError(f'{method} timed out after {timeout_s}s')
    finally:
        bus.signal_unsubscribe(sub)
    return result['code'], result['results']


def write_bounded(fd, data, deadline_s=2.0):
    """Write all of `data` to fd or give up at the deadline. A consumer that
    stops reading mid-transfer must not wedge the main loop (this runs on
    the signal-dispatch thread)."""
    import select as _select
    os.set_blocking(fd, False)
    end = time.time() + deadline_s
    view = memoryview(data)
    while view:
        remaining = end - time.time()
        if remaining <= 0:
            raise TimeoutError('selection consumer stalled')
        _, w, _ = _select.select([], [fd], [], remaining)
        if not w:
            raise TimeoutError('selection consumer stalled')
        try:
            n = os.write(fd, view[:65536])
        except BlockingIOError:
            continue
        view = view[n:]


def on_selection_transfer(conn, sender, path, siface, member, params):
    sess, mime, serial = params.unpack()
    if sess != state['session']:
        return
    with state_lock:
        text = state['selection_text']
    try:
        res, fdlist = bus.call_with_unix_fd_list_sync(
            PORTAL, PPATH, CLIP, 'SelectionWrite',
            GLib.Variant('(ou)', (sess, serial)), GLib.VariantType('(h)'),
            0, -1, None, None)
        fd = fdlist.get(res.unpack()[0])
        try:
            write_bounded(fd, text.encode('utf-8'))
        finally:
            os.close(fd)
        call(CLIP, 'SelectionWriteDone', GLib.Variant('(oub)', (sess, serial, True)))
    except Exception as e:  # noqa: BLE001 — serving must never kill the loop
        emit({'event': 'transfer_error', 'message': str(e)})


def on_owner_changed(conn, sender, path, siface, member, params):
    sess, options = params.unpack()
    if sess != state['session']:
        return
    if options.get('session_is_owner'):
        state['foreign_mimes'] = []
    else:
        mimes = options.get('mime_types')
        state['foreign_mimes'] = list(mimes) if mimes else []


def on_session_closed(conn, sender, path, siface, member, params):
    if path == state['session']:
        state['session'] = None
        emit({'event': 'closed'})


def setup_session(allow_retry=True):
    def cs_args(token):
        return GLib.Variant('(a{sv})', ({
            'handle_token': GLib.Variant('s', token),
            'session_handle_token': GLib.Variant('s', f'wvs_{os.getpid()}')},))

    code, results = portal_request(RD, 'CreateSession', cs_args, timeout_s=15)
    if code != 0:
        emit({'event': 'failed', 'code': code, 'denied': code == 1})
        return False
    session = results['session_handle']
    state['session'] = session

    # Must be requested before Start for clipboard_enabled to come back true.
    call(CLIP, 'RequestClipboard', GLib.Variant('(oa{sv})', (session, {})))

    select_opts = {
        'types': GLib.Variant('u', 1),  # KEYBOARD
        'persist_mode': GLib.Variant('u', 2),  # until revoked
    }
    used_restore = False
    if TOKEN_FILE:
        try:
            with open(TOKEN_FILE, encoding='utf-8') as f:
                tok = json.load(f).get('token')
            if isinstance(tok, str) and tok:
                select_opts['restore_token'] = GLib.Variant('s', tok)
                used_restore = True
        except (OSError, ValueError):
            pass

    def sd_args(token):
        opts = dict(select_opts)
        opts['handle_token'] = GLib.Variant('s', token)
        return GLib.Variant('(oa{sv})', (session, opts))

    code, _ = portal_request(RD, 'SelectDevices', sd_args, timeout_s=15)
    if code != 0:
        emit({'event': 'failed', 'code': code, 'denied': code == 1})
        return False

    def st_args(token):
        return GLib.Variant('(osa{sv})', (session, '', {
            'handle_token': GLib.Variant('s', token)}))

    code, results = portal_request(RD, 'Start', st_args, timeout_s=300)
    if code != 0:
        # A stale restore token can also fail Start — drop it so the next
        # attempt re-prompts instead of failing forever.
        if TOKEN_FILE:
            try:
                os.unlink(TOKEN_FILE)
            except OSError:
                pass
        emit({'event': 'failed', 'code': code, 'denied': code == 1})
        return False

    new_token = results.get('restore_token')
    if TOKEN_FILE and isinstance(new_token, str) and new_token:
        try:
            fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({'token': new_token}, f)
        except OSError:
            pass

    state['clipboard'] = bool(results.get('clipboard_enabled', False))

    # A restore token minted by an older WindVoice build (before the
    # clipboard capability existed) restores a session WITHOUT clipboard
    # access — clipboard_enabled comes back false even though we called
    # RequestClipboard. Drop the stale token and build a fresh session
    # once; the new grant includes the clipboard.
    if not state['clipboard'] and used_restore and allow_retry:
        try:
            bus.call_sync(PORTAL, session, SESSION_IFACE, 'Close',
                          GLib.Variant('()', ()), None, 0, -1, None)
        except Exception:  # noqa: BLE001
            pass
        state['session'] = None
        if TOKEN_FILE:
            try:
                os.unlink(TOKEN_FILE)
            except OSError:
                pass
        return setup_session(allow_retry=False)

    bus.signal_subscribe(None, CLIP, 'SelectionTransfer', PPATH, None, 0,
                         on_selection_transfer)
    bus.signal_subscribe(None, CLIP, 'SelectionOwnerChanged', PPATH, None, 0,
                         on_owner_changed)
    bus.signal_subscribe(None, SESSION_IFACE, 'Closed', None, None, 0,
                         on_session_closed)
    emit({'event': 'ready', 'clipboard': state['clipboard']})
    return True


def read_selection_text(deadline_s=1.0):
    """Current clipboard text, or None (non-text / empty / read refused).

    MUST be bounded: the portal hands us the read end of a pipe that the
    CURRENT selection owner is asked to fill. If that owner died (e.g. a
    previous WindVoice instance that held the selection), nothing ever
    arrives and a blocking read wedges the whole op queue — observed live
    as every paste timing out after the app was restarted. A missed
    restore is a shrug; a wedged sidecar kills pasting entirely.
    """
    import select as _select
    session = state['session']
    if not session or not state['clipboard']:
        return None
    # Only read when a FOREIGN owner with a text mime is known to exist.
    # Reading blind crashes GNOME 46's portal backend (see state comment);
    # reading our own selection is pointless (we already know the text).
    mimes = state['foreign_mimes']
    if not mimes or not any('text' in m.lower() or m in ('UTF8_STRING', 'STRING') for m in mimes):
        return None
    try:
        res, fdlist = bus.call_with_unix_fd_list_sync(
            PORTAL, PPATH, CLIP, 'SelectionRead',
            GLib.Variant('(os)', (session, 'text/plain;charset=utf-8')),
            GLib.VariantType('(h)'), 0, 3000, None, None)
        fd = fdlist.get(res.unpack()[0])
        os.set_blocking(fd, False)
        chunks = []
        end = time.time() + deadline_s
        try:
            while True:
                remaining = end - time.time()
                if remaining <= 0:
                    return None  # owner never delivered — skip restore
                r, _, _ = _select.select([fd], [], [], remaining)
                if not r:
                    return None
                try:
                    b = os.read(fd, 65536)
                except BlockingIOError:
                    continue
                if not b:
                    break
                chunks.append(b)
                if sum(len(c) for c in chunks) > 1_000_000:
                    return None  # too large to round-trip, skip restore
        finally:
            os.close(fd)
        return b''.join(chunks).decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001
        return None


def set_selection(text):
    session = state['session']
    if not session or not state['clipboard']:
        raise RuntimeError('clipboard capability unavailable')
    with state_lock:
        state['selection_text'] = text
    call(CLIP, 'SetSelection', GLib.Variant('(oa{sv})', (session, {
        'mime_types': GLib.Variant('as', MIME_TYPES)})))


def inject_ctrl_v():
    session = state['session']
    if not session:
        raise RuntimeError('session unavailable')

    def key(code, down):
        call(RD, 'NotifyKeyboardKeycode',
             GLib.Variant('(oa{sv}iu)', (session, {}, code, 1 if down else 0)))

    key(KEY_LEFTCTRL, True)
    key(KEY_V, True)
    time.sleep(0.01)
    key(KEY_V, False)
    key(KEY_LEFTCTRL, False)


def handle(msg):
    op = msg.get('op')
    rid = msg.get('id')
    try:
        if op == 'ping':
            emit({'id': rid, 'ok': True})
        elif op == 'snapshot':
            emit({'id': rid, 'ok': True, 'text': read_selection_text()})
        elif op == 'set_selection':
            set_selection(str(msg.get('text', '')))
            emit({'id': rid, 'ok': True})
        elif op == 'key_paste':
            inject_ctrl_v()
            emit({'id': rid, 'ok': True})
        elif op == 'paste':
            text = str(msg.get('text', ''))
            restore = bool(msg.get('restore', True))
            settle = max(0, int(msg.get('settleMs', 150))) / 1000
            restore_delay = max(0, int(msg.get('restoreMs', 1500))) / 1000
            old = read_selection_text() if restore else None
            set_selection(text)
            time.sleep(settle)
            inject_ctrl_v()
            if restore and old is not None:
                time.sleep(restore_delay)
                set_selection(old)
            emit({'id': rid, 'ok': True, 'restored': restore and old is not None})
        else:
            emit({'id': rid, 'ok': False, 'error': f'unknown op {op!r}'})
    except Exception as e:  # noqa: BLE001 — report, never crash the sidecar
        emit({'id': rid, 'ok': False, 'error': str(e)})
        # If the portal itself died (NoReply / ServiceUnknown), our session
        # is gone with it. Exit so the parent respawns us into a fresh
        # session against the auto-restarted portal.
        msg = str(e)
        if 'NoReply' in msg or 'ServiceUnknown' in msg or 'NameHasNoOwner' in msg:
            emit({'event': 'closed'})
            os._exit(1)


def stdin_worker():
    if not setup_session():
        # Stay alive so the parent reads the failure event before EOF races;
        # it will kill us.
        time.sleep(3600)
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            emit({'event': 'protocol_error', 'line': line[:200]})
            continue
        handle(msg)
    os._exit(0)  # parent closed stdin


threading.Thread(target=stdin_worker, daemon=True).start()
GLib.MainLoop().run()
