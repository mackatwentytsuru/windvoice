"""Dependency-free clipboard lifecycle primitives for portal-remote.py."""

import threading
import time


class SelectionOwnerTimeout(TimeoutError):
    """The portal accepted SetSelection but never confirmed ownership."""


class OwnerChangeBarrier:
    """Correlate each selection claim with a fresh owner-change signal.

    ``session_is_owner`` can already be true from the previous clipboard
    value. A boolean alone therefore cannot acknowledge a new SetSelection;
    every caller must checkpoint the monotonically increasing signal sequence.
    """

    def __init__(self):
        self._condition = threading.Condition()
        self._sequence = 0
        self._is_owner = False

    def reset(self):
        with self._condition:
            self._sequence += 1
            self._is_owner = False
            self._condition.notify_all()

    def owner_changed(self, is_owner):
        with self._condition:
            self._sequence += 1
            self._is_owner = bool(is_owner)
            self._condition.notify_all()

    def checkpoint(self):
        with self._condition:
            return self._sequence

    def wait_until_owned(self, after_sequence, timeout_s):
        end = time.monotonic() + timeout_s
        with self._condition:
            while True:
                if self._sequence > after_sequence and self._is_owner:
                    return True
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)


def apply_selection_and_wait_for_owner(barrier, apply_selection, timeout_s):
    """Apply SetSelection and wait for its compositor ownership signal.

    xdg-desktop-portal acknowledges SetSelection before its asynchronous
    backend call has necessarily reached the compositor. The subsequent
    SelectionOwnerChanged signal is the observable application boundary.
    """
    checkpoint = barrier.checkpoint()
    apply_selection()
    if not barrier.wait_until_owned(checkpoint, timeout_s):
        raise SelectionOwnerTimeout(
            'selection ownership was not confirmed before the deadline'
        )
    return True
