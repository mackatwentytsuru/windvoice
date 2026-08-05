import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = path.resolve('resources/native/portal-remote.py');
const helperDir = path.resolve('resources/native');

const PROBE = String.raw`
import ast
import json
import sys

source_path = sys.argv[1]
sys.path.insert(0, sys.argv[2])
from portal_input import run_verified_paste_attempts

tree = ast.parse(open(source_path, encoding='utf-8').read(), source_path)
function_names = {
    'clamp_key_event_delay',
    'build_mandatory_paste_attempts',
    'emit_fallback_trace',
    'handle_paste',
}
functions = [
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name in function_names
]
module = ast.Module(body=functions, type_ignores=[])

receipt_plan = [value == 'true' for value in sys.argv[3].split(',')]
claims = []
injections = []
checkpoints = []
receipts = []
emissions = []

class SelectionOwnerTimeout(TimeoutError):
    pass

class FakeTime:
    @staticmethod
    def sleep(_seconds):
        pass

def set_selection(text):
    claims.append(text)
    return 7

def checkpoint():
    value = len(checkpoints) + 100
    checkpoints.append(value)
    return value

def inject(shortcut, method, inter_event_ms):
    injections.append({
        'shortcut': shortcut,
        'method': method,
        'interEventMs': inter_event_ms,
    })
    return True

def verify(generation, after_request_seq, timeout_s):
    receipts.append({
        'generation': generation,
        'checkpoint': after_request_seq,
        'timeout': timeout_s,
    })
    return receipt_plan[len(receipts) - 1]

def emit_result(*args, **kwargs):
    emissions.append({'args': list(args), 'kwargs': kwargs})

namespace = {
    'get_focused_app_id': lambda: 'com.anthropic.Claude.desktop',
    'read_selection_snapshot': lambda: {'ok': True, 'kind': 'empty'},
    'set_selection': set_selection,
    'SelectionOwnerTimeout': SelectionOwnerTimeout,
    'time': FakeTime,
    'transfer_checkpoint': checkpoint,
    'inject_paste_chord': inject,
    'wait_for_selection_read': verify,
    'run_verified_paste_attempts': run_verified_paste_attempts,
    'InjectionError': RuntimeError,
    'emit_paste_result': emit_result,
    'exit_if_portal_unavailable': lambda _error: None,
    'MAX_KEY_EVENT_DELAY_MS': 250,
    'sys': sys,
}
exec(compile(module, source_path, 'exec'), namespace)

message = {
    'text': 'hello',
    'restore': False,
    'settleMs': 0,
    'restoreMs': 0,
    'verifyMs': 750,
}
if sys.argv[4] == 'with-attempts':
    message['attempts'] = [
        {'shortcut': 'ctrl-shift-v', 'method': 'keycode', 'interEventMs': 20},
        {'shortcut': 'ctrl-shift-v', 'method': 'keycode', 'interEventMs': 60},
        {'shortcut': 'ctrl-v', 'method': 'keysym', 'interEventMs': 60},
    ]

namespace['handle_paste'](message, 42)

print(json.dumps({
    'claims': claims,
    'injections': injections,
    'checkpoints': checkpoints,
    'receipts': receipts,
    'emission': emissions[-1],
}))
`;

function probe(receipts: string, includeAttempts = true): Record<string, unknown> {
  const run = spawnSync(
    'python3',
    ['-c', PROBE, source, helperDir, receipts, includeAttempts ? 'with-attempts' : 'legacy'],
    { encoding: 'utf8' }
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe('portal-remote verified paste fallback integration', () => {
  it('claims once and stops the fallback chain at the first receipt', () => {
    expect(probe('false,true,true')).toMatchObject({
      claims: ['hello'],
      injections: [
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 20 },
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 60 }
      ],
      checkpoints: [100, 101],
      receipts: [
        { generation: 7, checkpoint: 100, timeout: 0.75 },
        { generation: 7, checkpoint: 101, timeout: 0.75 }
      ],
      emission: {
        args: [42, true, true, true, false],
        kwargs: {
          target_app: 'com.anthropic.Claude.desktop',
          attempts: [
            { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: false },
            { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: true }
          ]
        }
      }
    });
  });

  it('uses keysym plain paste only after both chord receipts fail', () => {
    expect(probe('false,false,false')).toMatchObject({
      claims: ['hello'],
      injections: [
        { shortcut: 'ctrl-shift-v', method: 'keycode' },
        { shortcut: 'ctrl-shift-v', method: 'keycode' },
        { shortcut: 'ctrl-v', method: 'keysym' }
      ],
      checkpoints: [100, 101, 102],
      emission: {
        args: [
          42,
          true,
          true,
          false,
          false,
          'verify',
          'no post-injection selection read was observed'
        ]
      }
    });
  });

  it('runs the mandatory fallback chain when an older TS caller omits attempts', () => {
    expect(probe('false,false,false', false)).toMatchObject({
      injections: [
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 20 },
        { shortcut: 'ctrl-shift-v', method: 'keycode', interEventMs: 60 },
        { shortcut: 'ctrl-v', method: 'keysym', interEventMs: 60 }
      ],
      checkpoints: [100, 101, 102],
      emission: {
        kwargs: {
          attempts: [
            { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: false },
            { shortcut: 'ctrl-shift-v', method: 'keycode', selectionRead: false },
            { shortcut: 'ctrl-v', method: 'keysym', selectionRead: false }
          ]
        }
      }
    });
  });
});
