"""Pure, unit-testable virtual-key chord dispatch for portal-remote.py."""

import time


KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V = 29, 42, 47
KEYSYM_LEFTCTRL, KEYSYM_LEFTSHIFT, KEYSYM_V = 0xffe3, 0xffe1, 0x76

KEYS = {
    'keycode': {
        'ctrl': KEY_LEFTCTRL,
        'shift': KEY_LEFTSHIFT,
        'v': KEY_V,
    },
    'keysym': {
        'ctrl': KEYSYM_LEFTCTRL,
        'shift': KEYSYM_LEFTSHIFT,
        'v': KEYSYM_V,
    },
}


class InjectionError(RuntimeError):
    def __init__(self, error, injected, cleanup_errors):
        super().__init__(str(error))
        self.injected = injected
        self.cleanup_errors = cleanup_errors


def inject_paste_chord(
        key, shortcut='ctrl-shift-v', method='keycode',
        inter_event_delay_s=0.02, sleep_fn=time.sleep):
    """Dispatch a paste chord and always make best-effort key-up calls.

    `injected` is deliberately tri-state on failure: False means V-down was
    never sent, while None means the target may have received a partial chord.
    """
    if method not in KEYS:
        raise ValueError(f'unsupported injection method: {method!r}')
    keys = KEYS[method]
    if shortcut == 'ctrl-shift-v':
        modifiers = [keys['ctrl'], keys['shift']]
    elif shortcut == 'ctrl-v':
        modifiers = [keys['ctrl']]
    else:
        raise ValueError(f'unsupported paste shortcut: {shortcut!r}')
    event_delay = max(0.0, float(inter_event_delay_s))

    dispatched = False
    primary_error = None
    cleanup_errors = []
    try:
        for code in modifiers:
            key(code, True)
            if event_delay:
                sleep_fn(event_delay)
        key(keys['v'], True)
        dispatched = True
        if event_delay:
            sleep_fn(event_delay)
    except Exception as error:  # noqa: BLE001
        primary_error = error
    finally:
        # Releases are explicit and ordered V -> Shift -> Ctrl. Even if a
        # key-down failed, redundant key-up is harmless; a skipped release can
        # poison every application until the virtual device is destroyed.
        release_codes = [keys['v'], *reversed(modifiers)]
        for index, code in enumerate(release_codes):
            try:
                key(code, False)
                if event_delay and index < len(release_codes) - 1:
                    sleep_fn(event_delay)
            except Exception as error:  # noqa: BLE001
                cleanup_errors.append(error)

    if primary_error is not None or cleanup_errors:
        parts = []
        if primary_error is not None:
            parts.append(str(primary_error))
        if cleanup_errors:
            parts.append(
                'modifier cleanup failed: '
                + '; '.join(str(error) for error in cleanup_errors)
            )
        injected = None if dispatched else False
        raise InjectionError('; '.join(parts), injected, cleanup_errors)
    return True


def run_verified_paste_attempts(
        attempts, inject, checkpoint, verify, on_result=None):
    """Run ordered paste attempts, requiring a fresh receipt after each one.

    A successful SelectionTransfer is the stop condition. Keeping checkpoint
    acquisition and receipt verification inside this loop makes it impossible
    for a later fallback to run after delivery has already been confirmed.
    Injection exceptions deliberately propagate: an uncertain/partial chord
    must not be retried because doing so could duplicate text.
    """
    results = []
    last_injected = False
    for index, attempt in enumerate(attempts, start=1):
        after_request_seq = checkpoint()
        last_injected = inject(attempt)
        selection_read = bool(
            last_injected is True and verify(after_request_seq)
        )
        result = dict(attempt)
        result['injected'] = last_injected
        result['selectionRead'] = selection_read
        results.append(result)
        if on_result is not None:
            on_result(result)
        if selection_read:
            return {
                'injected': True,
                'selectionRead': True,
                'successfulAttempt': index,
                'attempts': results,
            }
    return {
        'injected': last_injected,
        'selectionRead': False,
        'successfulAttempt': None,
        'attempts': results,
    }
