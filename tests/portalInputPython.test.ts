import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helperDir = path.resolve('resources/native');

const PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_input import InjectionError, inject_paste_chord

scenario = sys.argv[2]
method = sys.argv[3]
events = []
sleeps = []

def key(code, down):
    events.append([code, down])
    if scenario == 'release-failure' and code == 47 and down is False:
        raise RuntimeError('V-up failed')

try:
    result = inject_paste_chord(
        key,
        'ctrl-shift-v',
        method=method,
        inter_event_delay_s=0.025,
        sleep_fn=sleeps.append,
    )
    print(json.dumps({'result': result, 'events': events, 'sleeps': sleeps}))
except InjectionError as error:
    print(json.dumps({
        'injected': error.injected,
        'cleanupErrors': len(error.cleanup_errors),
        'events': events,
        'sleeps': sleeps,
    }))
`;

const FALLBACK_PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_input import run_verified_paste_attempts

receipt_plan = [value == 'true' for value in sys.argv[2].split(',')]
attempts = [
    {'shortcut': 'ctrl-shift-v', 'method': 'keycode', 'interEventMs': 20},
    {'shortcut': 'ctrl-shift-v', 'method': 'keycode', 'interEventMs': 60},
    {'shortcut': 'ctrl-v', 'method': 'keysym', 'interEventMs': 60},
]
injections = []
checkpoints = []
receipts = []

def checkpoint():
    value = len(checkpoints) + 100
    checkpoints.append(value)
    return value

def inject(attempt):
    injections.append(dict(attempt))
    return True

def verify(after_checkpoint):
    receipts.append(after_checkpoint)
    return receipt_plan[len(receipts) - 1]

result = run_verified_paste_attempts(attempts, inject, checkpoint, verify)
print(json.dumps({
    'result': result,
    'injections': injections,
    'checkpoints': checkpoints,
    'receipts': receipts,
}))
`;

const PORTAL_DISPATCH_PROBE = String.raw`
import ast
import json
import sys
import threading

source_path = sys.argv[1]
helper_dir = sys.argv[2]
sys.path.insert(0, helper_dir)
from portal_input import inject_paste_chord as dispatch_paste_chord

tree = ast.parse(open(source_path, encoding='utf-8').read(), source_path)
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'inject_paste_chord'
)
module = ast.Module(body=[function], type_ignores=[])
calls = []

class FakeGLib:
    @staticmethod
    def Variant(_signature, value):
        return value

def call(_interface, method, value):
    _session, _options, code, state = value
    calls.append([method, code, state])

namespace = {
    'state': {'session': '/session'},
    'state_lock': threading.Lock(),
    'RD': 'remote-desktop',
    'GLib': FakeGLib,
    'call': call,
    'dispatch_paste_chord': dispatch_paste_chord,
    'MAX_KEY_EVENT_DELAY_MS': 250,
}
exec(compile(module, source_path, 'exec'), namespace)
namespace['inject_paste_chord']('ctrl-v', 'keysym', 0)
print(json.dumps(calls))
`;

function probe(
  scenario: 'success' | 'release-failure',
  method: 'keycode' | 'keysym' = 'keycode'
): Record<string, unknown> {
  const run = spawnSync('python3', ['-c', PROBE, helperDir, scenario, method], {
    encoding: 'utf8'
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe('Wayland virtual paste chord cleanup', () => {
  it('uses Ctrl+Shift+V and releases every pressed key in reverse order', () => {
    expect(probe('success')).toEqual({
      result: true,
      events: [
        [29, true],
        [42, true],
        [47, true],
        [47, false],
        [42, false],
        [29, false]
      ],
      sleeps: [0.025, 0.025, 0.025, 0.025, 0.025]
    });
  });

  it('can dispatch the same explicit sequence with XKB keysyms', () => {
    expect(probe('success', 'keysym')).toEqual({
      result: true,
      events: [
        [0xffe3, true],
        [0xffe1, true],
        [0x76, true],
        [0x76, false],
        [0xffe1, false],
        [0xffe3, false]
      ],
      sleeps: [0.025, 0.025, 0.025, 0.025, 0.025]
    });
  });

  it('routes the keysym sequence through NotifyKeyboardKeysym', () => {
    const source = path.resolve('resources/native/portal-remote.py');
    const run = spawnSync('python3', ['-c', PORTAL_DISPATCH_PROBE, source, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      ['NotifyKeyboardKeysym', 0xffe3, 1],
      ['NotifyKeyboardKeysym', 0x76, 1],
      ['NotifyKeyboardKeysym', 0x76, 0],
      ['NotifyKeyboardKeysym', 0xffe3, 0]
    ]);
  });

  it('continues releasing modifiers and reports unknown dispatch after a key-up failure', () => {
    expect(probe('release-failure')).toEqual({
      injected: null,
      cleanupErrors: 1,
      events: [
        [29, true],
        [42, true],
        [47, true],
        [47, false],
        [42, false],
        [29, false]
      ],
      sleeps: [0.025, 0.025, 0.025, 0.025]
    });
  });

  it('verifies every attempt and stops before any duplicate-producing fallback', () => {
    const run = spawnSync('python3', ['-c', FALLBACK_PROBE, helperDir, 'false,true,true'], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      result: {
        injected: true,
        selectionRead: true,
        successfulAttempt: 2,
        attempts: [
          {
            shortcut: 'ctrl-shift-v',
            method: 'keycode',
            interEventMs: 20,
            injected: true,
            selectionRead: false
          },
          {
            shortcut: 'ctrl-shift-v',
            method: 'keycode',
            interEventMs: 60,
            injected: true,
            selectionRead: true
          }
        ]
      },
      injections: [
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 20 },
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 60 }
      ],
      checkpoints: [100, 101],
      receipts: [100, 101]
    });
  });

  it('reaches the keysym Ctrl+V fallback only after both chord receipts fail', () => {
    const run = spawnSync('python3', ['-c', FALLBACK_PROBE, helperDir, 'false,false,false'], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      result: {
        injected: true,
        selectionRead: false,
        successfulAttempt: null,
        attempts: [
          { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: false },
          { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: false },
          { shortcut: 'ctrl-v', method: 'keysym', selectionRead: false }
        ]
      },
      checkpoints: [100, 101, 102],
      receipts: [100, 101, 102]
    });
  });
});
