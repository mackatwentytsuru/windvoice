import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helperDir = path.resolve('resources/native');

const PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_clipboard import (
    OwnerChangeBarrier,
    SelectionOwnerTimeout,
    apply_selection_and_wait_for_owner,
)

barrier = OwnerChangeBarrier()
results = []

# Every SetSelection needs a new owner-change acknowledgement. Merely still
# being the owner from the previous claim must not satisfy the next claim.
for _ in range(3):
    checkpoint = barrier.checkpoint()
    results.append(barrier.wait_until_owned(checkpoint, 0))
    barrier.owner_changed(True)
    results.append(barrier.wait_until_owned(checkpoint, 0))

# Losing ownership must also be visible, and a session reset must invalidate
# the previous session's last owned state.
lost_checkpoint = barrier.checkpoint()
barrier.owner_changed(False)
results.append(barrier.wait_until_owned(lost_checkpoint, 0))
barrier.owner_changed(True)
reset_checkpoint = barrier.checkpoint()
barrier.reset()
results.append(barrier.wait_until_owned(reset_checkpoint, 0))

print(json.dumps(results))
`;

const NEGATIVE_EVENT_PROBE = String.raw`
import json
import sys
import threading
import time

sys.path.insert(0, sys.argv[1])
from portal_clipboard import OwnerChangeBarrier

barrier = OwnerChangeBarrier()

# A foreign-owner notification can race ahead of the asynchronous claim's
# owned notification. It must wake the waiter without terminating it early.
checkpoint = barrier.checkpoint()
barrier.owner_changed(False)
owned_thread = threading.Thread(
    target=lambda: (time.sleep(0.02), barrier.owner_changed(True))
)
owned_thread.start()
recovered = barrier.wait_until_owned(checkpoint, 0.2)
owned_thread.join()

# If ownership never arrives, the same foreign-owner notification must still
# wait for the configured deadline instead of being mistaken for final proof.
checkpoint = barrier.checkpoint()
barrier.owner_changed(False)
started = time.monotonic()
timed_out = barrier.wait_until_owned(checkpoint, 0.03)
elapsed = time.monotonic() - started

print(json.dumps({
    'recovered': recovered,
    'timedOut': timed_out,
    'waitedForDeadline': elapsed >= 0.02,
}))
`;

const OWNER_SIGNAL_PROBE = String.raw`
import ast
import json
import sys
import threading

source_path = sys.argv[1]
tree = ast.parse(open(source_path, encoding='utf-8').read(), source_path)
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'on_owner_changed'
)
module = ast.Module(body=[function], type_ignores=[])

class WrappedVariant:
    def __init__(self, value):
        self.value = value

    def unpack(self):
        return self.value

class Params:
    def __init__(self, is_owner):
        self.is_owner = is_owner

    def unpack(self):
        return ('/session', {
            'session_is_owner': WrappedVariant(self.is_owner),
            'mime_types': ['text/plain'],
        })

class Barrier:
    def __init__(self):
        self.values = []

    def owner_changed(self, value):
        self.values.append(value)

state = {
    'session': '/session',
    'selection_is_owner': True,
    'foreign_mimes': [],
}
barrier = Barrier()
namespace = {
    'state': state,
    'state_lock': threading.Lock(),
    'flatten_mimes': lambda value: list(value),
    'owner_change_barrier': barrier,
}
exec(compile(module, source_path, 'exec'), namespace)

namespace['on_owner_changed'](None, None, None, None, None, Params(False))
false_result = {
    'isOwner': state['selection_is_owner'],
    'foreignMimes': state['foreign_mimes'],
    'barrierValue': barrier.values[-1],
}
namespace['on_owner_changed'](None, None, None, None, None, Params(True))
true_result = {
    'isOwner': state['selection_is_owner'],
    'foreignMimes': state['foreign_mimes'],
    'barrierValue': barrier.values[-1],
}

print(json.dumps({'falseResult': false_result, 'trueResult': true_result}))
`;

const SELECTION_STATE_PROBE = String.raw`
import ast
import json
import sys
import threading

source_path = sys.argv[1]
tree = ast.parse(open(source_path, encoding='utf-8').read(), source_path)
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'set_selection'
)
module = ast.Module(body=[function], type_ignores=[])

class SelectionOwnerTimeout(TimeoutError):
    pass

class FakeGLib:
    @staticmethod
    def Variant(_signature, value):
        return value

mode = {'value': 'owner-timeout'}
state = {
    'session': '/session',
    'clipboard': True,
    'selection_text': 'old text',
    'selection_generation': 7,
}

def call(*_args):
    if mode['value'] == 'sync-error':
        raise RuntimeError('synchronous D-Bus failure')

def apply_selection_and_wait_for_owner(_barrier, apply_selection, _timeout):
    apply_selection()
    raise SelectionOwnerTimeout('owner confirmation timed out')

namespace = {
    'state': state,
    'state_lock': threading.Lock(),
    'CLIP': 'clipboard-interface',
    'MIME_TYPES': ['text/plain'],
    'GLib': FakeGLib,
    'call': call,
    'owner_change_barrier': object(),
    'SELECTION_OWNER_TIMEOUT_S': 2.0,
    'SelectionOwnerTimeout': SelectionOwnerTimeout,
    'apply_selection_and_wait_for_owner': apply_selection_and_wait_for_owner,
}
exec(compile(module, source_path, 'exec'), namespace)

try:
    namespace['set_selection']('new text')
except SelectionOwnerTimeout:
    pass
timeout_state = {
    'text': state['selection_text'],
    'generation': state['selection_generation'],
}

state['selection_text'] = 'old text'
state['selection_generation'] = 7
mode['value'] = 'sync-error'
try:
    namespace['set_selection']('new text')
except RuntimeError:
    pass
sync_error_state = {
    'text': state['selection_text'],
    'generation': state['selection_generation'],
}

print(json.dumps({
    'ownerTimeout': timeout_state,
    'syncError': sync_error_state,
}))
`;

const CLAIM_PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_clipboard import (
    OwnerChangeBarrier,
    SelectionOwnerTimeout,
    apply_selection_and_wait_for_owner,
)

barrier = OwnerChangeBarrier()
barrier.owner_changed(True)
results = []

try:
    apply_selection_and_wait_for_owner(barrier, lambda: None, 0)
except SelectionOwnerTimeout:
    results.append('stale-owner-rejected')

for index in range(3):
    results.append(apply_selection_and_wait_for_owner(
        barrier,
        lambda: barrier.owner_changed(True),
        0,
    ))

print(json.dumps(results))
`;

describe('Wayland clipboard owner-change barrier', () => {
  it('requires a fresh ownership acknowledgement for every selection claim', () => {
    const run = spawnSync('python3', ['-c', PROBE, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      false
    ]);
  });

  it('does not treat an asynchronously forwarded SetSelection call as applied', () => {
    const run = spawnSync('python3', ['-c', CLAIM_PROBE, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      'stale-owner-rejected',
      true,
      true,
      true
    ]);
  });

  it('waits through a foreign-owner notification for a later owned notification', () => {
    const run = spawnSync('python3', ['-c', NEGATIVE_EVENT_PROBE, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      recovered: true,
      timedOut: false,
      waitedForDeadline: true
    });
  });

  it('unpacks wrapped session owner booleans before updating the barrier', () => {
    const source = path.resolve('resources/native/portal-remote.py');
    const run = spawnSync('python3', ['-c', OWNER_SIGNAL_PROBE, source], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      falseResult: {
        isOwner: false,
        foreignMimes: ['text/plain'],
        barrierValue: false
      },
      trueResult: {
        isOwner: true,
        foreignMimes: [],
        barrierValue: true
      }
    });
  });

  it('retains a timed-out claim but rolls back a synchronous SetSelection failure', () => {
    const source = path.resolve('resources/native/portal-remote.py');
    const run = spawnSync('python3', ['-c', SELECTION_STATE_PROBE, source], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      ownerTimeout: { text: 'new text', generation: 8 },
      syncError: { text: 'old text', generation: 7 }
    });
  });
});
