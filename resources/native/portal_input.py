"""Pure, unit-testable virtual-key chord dispatch for portal-remote.py."""

import time


KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V = 29, 42, 47


class InjectionError(RuntimeError):
    def __init__(self, error, injected, cleanup_errors):
        super().__init__(str(error))
        self.injected = injected
        self.cleanup_errors = cleanup_errors


def inject_paste_chord(key, shortcut='ctrl-shift-v', sleep_fn=time.sleep):
    """Dispatch a paste chord and always make best-effort key-up calls.

    `injected` is deliberately tri-state on failure: False means V-down was
    never sent, while None means the target may have received a partial chord.
    """
    if shortcut == 'ctrl-shift-v':
        modifiers = [KEY_LEFTCTRL, KEY_LEFTSHIFT]
    elif shortcut == 'ctrl-v':
        modifiers = [KEY_LEFTCTRL]
    else:
        raise ValueError(f'unsupported paste shortcut: {shortcut!r}')

    dispatched = False
    primary_error = None
    cleanup_errors = []
    try:
        for code in modifiers:
            key(code, True)
        key(KEY_V, True)
        dispatched = True
        sleep_fn(0.01)
    except Exception as error:  # noqa: BLE001
        primary_error = error
    finally:
        # Redundant key-up is harmless; a skipped Ctrl/Shift-up can poison
        # every application until the virtual device is destroyed.
        for code in [KEY_V, *reversed(modifiers)]:
            try:
                key(code, False)
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
