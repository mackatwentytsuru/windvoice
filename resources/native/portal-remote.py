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
the main process cannot receive. PyGObject handles them natively, so this
small sidecar does.

Protocol (one JSON object per line):
  stdin:
    {"id":1,"op":"paste","text":"...","restore":true,
     "settleMs":150,"restoreMs":1500}
        Snapshot current selection (if restore), claim it with text, inject
        Ctrl+V, wait, restore the old selection. Replies when finished.
        -> {"id":1,"ok":true,"claimed":true,"injected":true,
            "restored":true}
    {"id":2,"op":"snapshot"}            -> {"id":2,"ok":true,"kind":"text",
                                             "text":"..."}
                                            or kind "empty" / "non-text"
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
import secrets
import sys
import threading
import time

try:
    import gi  # noqa: E402
    from gi.repository import GLib, Gio  # noqa: E402
except Exception as e:  # noqa: BLE001 — report missing/broken PyGObject cleanly
    sys.stdout.write(json.dumps({
        'event': 'failed',
        'code': -2,
        'denied': False,
        'stage': 'import',
        'message': (
            'PyGObject is required; install python3-gi (Debian/Ubuntu) or '
            f'python3-gobject (Fedora/Arch): {e}'
        ),
    }, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    raise SystemExit(2)

PORTAL = 'org.freedesktop.portal.Desktop'
PPATH = '/org/freedesktop/portal/desktop'
RD = 'org.freedesktop.portal.RemoteDesktop'
CLIP = 'org.freedesktop.portal.Clipboard'
REQ = 'org.freedesktop.portal.Request'
SESSION_IFACE = 'org.freedesktop.portal.Session'
KEY_LEFTCTRL, KEY_V = 29, 47
MIME_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'TEXT', 'STRING']
DBUS_TIMEOUT_MS = 3000

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
    'selection_is_owner': False,
    # Session paths deliberately closed while replacing a stale restore-token
    # session. Their Closed signals must not terminate the replacement.
    'expected_closes': set(),
}
state_lock = threading.Lock()


def is_dbus_timeout(error):
    try:
        if error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT):
            return True
    except (AttributeError, TypeError):
        pass
    try:
        if any(error.matches(Gio.dbus_error_quark(), code) for code in (
            Gio.DBusError.NO_REPLY,
            Gio.DBusError.TIMEOUT,
        )):
            return True
    except (AttributeError, TypeError):
        pass
    message = str(error)
    return any(marker in message for marker in (
        'Timeout was reached',
        'TimedOut',
        'timed out',
        'NoReply',
        'org.freedesktop.DBus.Error.Timeout',
    ))


def dbus_timeout_exit(method, error):
    emit({
        'event': 'failed',
        'code': -1,
        'denied': False,
        'stage': method,
        'message': f'D-Bus call timed out: {str(error)[:240]}',
    })
    os._exit(1)


def call_at(path, iface, method, variant, timeout_ms=DBUS_TIMEOUT_MS):
    try:
        return bus.call_sync(
            PORTAL, path, iface, method, variant, None, 0, timeout_ms, None)
    except Exception as e:
        if is_dbus_timeout(e):
            dbus_timeout_exit(method, e)
        raise


def call(iface, method, variant, timeout_ms=DBUS_TIMEOUT_MS):
    return call_at(PPATH, iface, method, variant, timeout_ms)


def call_with_fds(path, iface, method, variant, result_type,
                  timeout_ms=DBUS_TIMEOUT_MS):
    try:
        return bus.call_with_unix_fd_list_sync(
            PORTAL, path, iface, method, variant, result_type,
            0, timeout_ms, None, None)
    except Exception as e:
        if is_dbus_timeout(e):
            dbus_timeout_exit(method, e)
        raise


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

    sub = bus.signal_subscribe(
        PORTAL, REQ, 'Response', req_path, None, 0, on_signal)
    try:
        call(iface, method, build_args(token))
        if not done.wait(timeout_s):
            dbus_timeout_exit(
                method, TimeoutError(f'portal response timed out after {timeout_s}s'))
    finally:
        bus.signal_unsubscribe(sub)
    return result['code'], result['results']


def write_bounded(fd, data, deadline_s=2.0):
    """Write all of `data` to fd or give up at the deadline. A consumer that
    stops reading mid-transfer must not wedge a transfer worker."""
    import select as _select
    os.set_blocking(fd, False)
    end = time.monotonic() + deadline_s
    view = memoryview(data)
    while view:
        remaining = end - time.monotonic()
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


def serve_selection_transfer(sess, serial, text):
    with state_lock:
        if sess != state['session']:
            return
    try:
        res, fdlist = call_with_fds(
            PPATH, CLIP, 'SelectionWrite',
            GLib.Variant('(ou)', (sess, serial)), GLib.VariantType('(h)'),
        )
        fd = fdlist.get(res.unpack()[0])
        try:
            write_bounded(fd, text.encode('utf-8'))
        finally:
            os.close(fd)
        call(CLIP, 'SelectionWriteDone', GLib.Variant('(oub)', (sess, serial, True)))
    except Exception as e:  # noqa: BLE001 — serving must never kill the loop
        emit({'event': 'transfer_error', 'message': str(e)})


def on_selection_transfer(conn, sender, path, siface, member, params):
    sess, mime, serial = params.unpack()
    with state_lock:
        if sess != state['session']:
            return
        text = state['selection_text']
    # SelectionWrite returns an fd and the consumer may take time to drain it.
    # Keep every blocking operation off GLib's signal-dispatch thread so
    # Closed and owner-change signals remain responsive.
    threading.Thread(
        target=serve_selection_transfer,
        args=(sess, serial, text),
        daemon=True,
    ).start()


def flatten_mimes(value):
    """Normalize the mime_types option to a flat list of strings.

    Portal backends have shipped this as `as`, as a nested `aas`, and
    wrapped in a Variant; a non-string slipping through used to crash the
    paste op with "'list' object has no attribute 'lower'".
    """
    if value is None:
        return []
    if hasattr(value, 'unpack'):
        value = value.unpack()
    if isinstance(value, str):
        return [value]
    out = []
    try:
        for item in value:
            out.extend(flatten_mimes(item) if not isinstance(item, str) else [item])
    except TypeError:
        return []
    return out


def on_owner_changed(conn, sender, path, siface, member, params):
    sess, options = params.unpack()
    with state_lock:
        if sess != state['session']:
            return
        state['selection_is_owner'] = bool(options.get('session_is_owner'))
        if state['selection_is_owner']:
            state['foreign_mimes'] = []
        else:
            state['foreign_mimes'] = flatten_mimes(options.get('mime_types'))


def on_session_closed(conn, sender, path, siface, member, params):
    with state_lock:
        if path in state['expected_closes']:
            state['expected_closes'].discard(path)
            return
        if path != state['session']:
            return
        state['session'] = None
        state['clipboard'] = False
        state['selection_is_owner'] = False
        state['foreign_mimes'] = None
    emit({'event': 'closed'})
    # A sidecar without its session is useless — exit so the parent
    # respawns a fresh one instead of queueing ops against nothing.
    os._exit(1)


_subscribed = False


def subscribe_signals():
    global _subscribed
    if _subscribed:
        return
    _subscribed = True
    bus.signal_subscribe(PORTAL, CLIP, 'SelectionTransfer', PPATH, None, 0,
                         on_selection_transfer)
    bus.signal_subscribe(PORTAL, CLIP, 'SelectionOwnerChanged', PPATH, None, 0,
                         on_owner_changed)
    bus.signal_subscribe(PORTAL, SESSION_IFACE, 'Closed', None, None, 0,
                         on_session_closed)


def load_restore_token(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(path, flags)
    with os.fdopen(fd, encoding='utf-8') as f:
        data = json.load(f)
    token = data.get('token') if isinstance(data, dict) else None
    return token if isinstance(token, str) and token else None


def save_restore_token(path, token):
    """Atomically replace a restore-token file without following symlinks."""
    directory = os.path.dirname(path) or '.'
    basename = os.path.basename(path)
    temp_path = os.path.join(
        directory,
        f'.{basename}.tmp-{os.getpid()}-{secrets.token_hex(8)}',
    )
    fd = None
    try:
        flags = (
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        fd = os.open(temp_path, flags, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            fd = None
            json.dump({'token': token}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
        temp_path = None
    finally:
        if fd is not None:
            os.close(fd)
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def setup_session(allow_retry=True):
    session_token = f'wvs_{os.getpid()}_{time.monotonic_ns()}'

    def cs_args(token):
        return GLib.Variant('(a{sv})', ({
            'handle_token': GLib.Variant('s', token),
            'session_handle_token': GLib.Variant('s', session_token)},))

    code, results = portal_request(RD, 'CreateSession', cs_args, timeout_s=15)
    if code != 0:
        emit({'event': 'failed', 'code': code, 'denied': code == 1, 'stage': 'CreateSession'})
        return False
    session = results['session_handle']
    with state_lock:
        state['session'] = session
        state['clipboard'] = False
        state['selection_is_owner'] = False
        state['foreign_mimes'] = None

    # Subscribe BEFORE Start: the portal emits SelectionOwnerChanged as soon
    # as the clipboard is enabled, and a Closed can land during setup. A
    # missed owner notification silently disables clipboard restore for the
    # first paste; a missed Closed wedges us against a dead session.
    # Handlers filter by session path, so early subscription is safe.
    subscribe_signals()

    # Must be requested before Start for clipboard_enabled to come back true.
    # Portals without the Clipboard interface (KDE Plasma < 6.1,
    # xdg-desktop-portal < 1.18) raise here — degrade to keyboard-only
    # injection rather than aborting the whole session.
    try:
        call(CLIP, 'RequestClipboard', GLib.Variant('(oa{sv})', (session, {})))
        clipboard_requested = True
    except Exception as e:  # noqa: BLE001
        emit({'event': 'no_clipboard_iface', 'message': str(e)[:200]})
        clipboard_requested = False

    select_opts = {
        'types': GLib.Variant('u', 1),  # KEYBOARD
        'persist_mode': GLib.Variant('u', 2),  # until revoked
    }
    used_restore = False
    if TOKEN_FILE:
        try:
            tok = load_restore_token(TOKEN_FILE)
            if tok:
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
        emit({'event': 'failed', 'code': code, 'denied': code == 1, 'stage': 'SelectDevices'})
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
        emit({'event': 'failed', 'code': code, 'denied': code == 1, 'stage': 'Start'})
        return False

    new_token = results.get('restore_token')
    if TOKEN_FILE and isinstance(new_token, str) and new_token:
        try:
            save_restore_token(TOKEN_FILE, new_token)
        except OSError:
            pass

    with state_lock:
        state['clipboard'] = (
            clipboard_requested
            and bool(results.get('clipboard_enabled', False))
        )
        clipboard_enabled = state['clipboard']

    # A restore token minted by an older WindVoice build (before the
    # clipboard capability existed) restores a session WITHOUT clipboard
    # access — clipboard_enabled comes back false even though we called
    # RequestClipboard. Drop the stale token and build a fresh session
    # once; the new grant includes the clipboard.
    if not clipboard_enabled and used_restore and allow_retry:
        # Detach the current session and mark its eventual Closed signal as
        # expected before asking the compositor to close it. This ordering
        # prevents the signal handler from exiting during the retry.
        with state_lock:
            if state['session'] == session:
                state['session'] = None
                state['clipboard'] = False
                state['selection_is_owner'] = False
                state['foreign_mimes'] = None
            state['expected_closes'].add(session)
        try:
            call_at(
                session,
                SESSION_IFACE,
                'Close',
                GLib.Variant('()', ()),
            )
        except Exception:  # noqa: BLE001
            pass
        if TOKEN_FILE:
            try:
                os.unlink(TOKEN_FILE)
            except OSError:
                pass
        return setup_session(allow_retry=False)

    emit({'event': 'ready', 'clipboard': clipboard_enabled})
    return True


def read_selection_snapshot(deadline_s=1.0):
    """Return a text / empty / non-text snapshot without reading blindly.

    The portal hands us the read end of a pipe that the CURRENT selection
    owner is asked to fill. The pipe read is bounded because a dead owner
    can otherwise wedge the operation queue indefinitely.
    """
    import select as _select
    with state_lock:
        session = state['session']
        clipboard = state['clipboard']
        is_owner = state['selection_is_owner']
        own_text = state['selection_text']
        mimes = (
            list(state['foreign_mimes'])
            if state['foreign_mimes'] is not None
            else None
        )
    if not session or not clipboard:
        return {
            'ok': False,
            'error': 'clipboard capability unavailable',
        }
    if is_owner:
        return {'ok': True, 'kind': 'text', 'text': own_text}
    # Only read when a FOREIGN owner with a text mime is known to exist.
    # Reading blind crashes GNOME 46's portal backend (see state comment);
    # reading our own selection is pointless (we already know the text).
    if not mimes:
        return {'ok': True, 'kind': 'empty'}
    lowered_mimes = [
        mime.lower() for mime in mimes if isinstance(mime, str)
    ]
    # Images and file-manager selections often also expose a lossy text
    # fallback (alt text or file paths). Restoring only that fallback would
    # silently destroy the actual clipboard payload, so report non-text.
    if any(
        mime.startswith('image/')
        or mime == 'text/uri-list'
        or 'gnome-copied-files' in mime
        or 'kde-cutselection' in mime
        for mime in lowered_mimes
    ):
        return {'ok': True, 'kind': 'non-text'}
    # Ask for a mime the owner actually offers. X11/XWayland apps bridged
    # through the portal frequently advertise only the legacy atoms, and
    # hardcoding text/plain;charset=utf-8 would fail the read against them.
    offered_by_lower = {
        mime.lower(): mime for mime in mimes if isinstance(mime, str)
    }
    wanted = next((
        offered_by_lower[mime.lower()]
        for mime in MIME_TYPES
        if mime.lower() in offered_by_lower
    ), None)
    if wanted is None:
        return {'ok': True, 'kind': 'non-text'}
    try:
        res, fdlist = call_with_fds(
            PPATH, CLIP, 'SelectionRead',
            GLib.Variant('(os)', (session, wanted)),
            GLib.VariantType('(h)'),
        )
        fd = fdlist.get(res.unpack()[0])
        os.set_blocking(fd, False)
        chunks = []
        total = 0
        end = time.monotonic() + deadline_s
        try:
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return {
                        'ok': False,
                        'error': 'selection owner did not deliver text before the deadline',
                    }
                r, _, _ = _select.select([fd], [], [], remaining)
                if not r:
                    return {
                        'ok': False,
                        'error': 'selection owner did not deliver text before the deadline',
                    }
                try:
                    b = os.read(fd, 65536)
                except BlockingIOError:
                    continue
                if not b:
                    break
                chunks.append(b)
                total += len(b)
                if total > 1_000_000:
                    return {
                        'ok': False,
                        'error': 'selection text is too large to restore safely',
                    }
        finally:
            os.close(fd)
        return {
            'ok': True,
            'kind': 'text',
            'text': b''.join(chunks).decode('utf-8', 'replace'),
        }
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': str(e), '_exception': e}


def set_selection(text):
    with state_lock:
        session = state['session']
        if not session or not state['clipboard']:
            raise RuntimeError('clipboard capability unavailable')
        previous_text = state['selection_text']
        # Set this before the D-Bus call because SelectionTransfer can arrive
        # as soon as the claim is accepted.
        state['selection_text'] = text
    try:
        call(CLIP, 'SetSelection', GLib.Variant('(oa{sv})', (session, {
            'mime_types': GLib.Variant('as', MIME_TYPES)})))
    except Exception:
        with state_lock:
            state['selection_text'] = previous_text
        raise


class InjectionError(RuntimeError):
    def __init__(self, error, injected):
        super().__init__(str(error))
        self.injected = injected


def inject_ctrl_v():
    with state_lock:
        session = state['session']
        if not session:
            raise RuntimeError('session unavailable')

    def key(code, down):
        call(RD, 'NotifyKeyboardKeycode',
             GLib.Variant('(oa{sv}iu)', (session, {}, code, 1 if down else 0)))

    injected = False
    try:
        key(KEY_LEFTCTRL, True)
        key(KEY_V, True)
        injected = True
        time.sleep(0.01)
        key(KEY_V, False)
        key(KEY_LEFTCTRL, False)
    except Exception as e:
        raise InjectionError(e, injected) from e
    return True


def emit_paste_result(rid, claimed, injected, restored, stage=None, error=None):
    result = {
        'id': rid,
        'ok': bool(injected),
        'claimed': bool(claimed),
        'injected': bool(injected),
        'restored': bool(restored),
    }
    if stage is not None:
        result['stage'] = stage
    if error is not None:
        result['error'] = str(error)
    emit(result)


def exit_if_portal_unavailable(error):
    message = str(error)
    if any(marker in message for marker in (
        'ServiceUnknown',
        'NameHasNoOwner',
        'The connection is closed',
    )):
        emit({'event': 'closed'})
        os._exit(1)


def handle_paste(msg, rid):
    claimed = False
    injected = False
    restored = False
    try:
        text = str(msg.get('text', ''))
        restore = bool(msg.get('restore', True))
        settle = max(0, int(msg.get('settleMs', 150))) / 1000
        restore_delay = max(0, int(msg.get('restoreMs', 1500))) / 1000
    except (TypeError, ValueError, OverflowError) as e:
        emit_paste_result(
            rid, claimed, injected, restored, 'snapshot',
            f'invalid paste options: {e}',
        )
        return
    old_text = None
    snapshot_problem = None

    if restore:
        snapshot = read_selection_snapshot()
        if not snapshot['ok']:
            snapshot_problem = snapshot['error']
        elif snapshot['kind'] == 'text':
            old_text = snapshot['text']
        elif snapshot['kind'] == 'non-text':
            snapshot_problem = 'original selection is non-text and cannot be restored'

    try:
        set_selection(text)
        claimed = True
    except Exception as e:  # noqa: BLE001
        emit_paste_result(rid, claimed, injected, restored, 'claim', e)
        exit_if_portal_unavailable(e)
        return

    time.sleep(settle)
    inject_error = None
    try:
        injected = inject_ctrl_v()
    except InjectionError as e:
        injected = e.injected
        inject_error = e
    except Exception as e:  # noqa: BLE001
        inject_error = e

    restore_error = None
    if restore and old_text is not None:
        if injected:
            time.sleep(restore_delay)
        try:
            set_selection(old_text)
            restored = True
        except Exception as e:  # noqa: BLE001
            restore_error = e

    if inject_error is not None:
        emit_paste_result(
            rid, claimed, injected, restored, 'inject', inject_error)
        exit_if_portal_unavailable(inject_error)
        if restore_error is not None:
            exit_if_portal_unavailable(restore_error)
    elif restore_error is not None:
        emit_paste_result(
            rid, claimed, injected, restored, 'restore', restore_error)
        exit_if_portal_unavailable(restore_error)
    elif snapshot_problem is not None:
        emit_paste_result(
            rid, claimed, injected, restored, 'snapshot', snapshot_problem)
    else:
        emit_paste_result(rid, claimed, injected, restored)


def handle(msg):
    op = msg.get('op')
    rid = msg.get('id')
    try:
        if op == 'ping':
            emit({'id': rid, 'ok': True})
        elif op == 'snapshot':
            snapshot = read_selection_snapshot()
            response = {'id': rid, 'ok': snapshot['ok']}
            if snapshot['ok']:
                response['kind'] = snapshot['kind']
                if snapshot['kind'] == 'text':
                    response['text'] = snapshot['text']
            else:
                response['error'] = snapshot['error']
            emit(response)
            if '_exception' in snapshot:
                exit_if_portal_unavailable(snapshot['_exception'])
        elif op == 'set_selection':
            set_selection(str(msg.get('text', '')))
            emit({'id': rid, 'ok': True})
        elif op == 'key_paste':
            inject_ctrl_v()
            emit({'id': rid, 'ok': True})
        elif op == 'paste':
            handle_paste(msg, rid)
        else:
            emit({'id': rid, 'ok': False, 'error': f'unknown op {op!r}'})
    except Exception as e:  # noqa: BLE001 — report, never crash the sidecar
        emit({'id': rid, 'ok': False, 'error': str(e)})
        # If the portal itself died (NoReply / ServiceUnknown), our session
        # is gone with it. Exit so the parent respawns us into a fresh
        # session against the auto-restarted portal.
        exit_if_portal_unavailable(e)


def setup_session_guarded():
    """setup_session() with a hard exception boundary.

    Without this, a D-Bus error from any setup call (no RemoteDesktop
    backend on wlroots/sway, portal too old, daemon restarting) killed this
    worker thread while the GLib main loop kept the process alive: the
    sidecar would never emit ready OR failed, never read stdin, and never
    exit — so the supervisor saw a live child that answered nothing, and
    the user got no "backend unavailable" message at all.
    """
    try:
        return setup_session()
    except Exception as e:  # noqa: BLE001
        emit({'event': 'failed', 'code': -1, 'denied': False,
              'stage': 'exception', 'message': str(e)[:300]})
        return False


def stdin_worker():
    if not setup_session_guarded():
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
