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
events = []

def key(code, down):
    events.append([code, down])
    if scenario == 'release-failure' and code == 47 and down is False:
        raise RuntimeError('V-up failed')

try:
    result = inject_paste_chord(key, 'ctrl-shift-v', sleep_fn=lambda _: None)
    print(json.dumps({'result': result, 'events': events}))
except InjectionError as error:
    print(json.dumps({
        'injected': error.injected,
        'cleanupErrors': len(error.cleanup_errors),
        'events': events,
    }))
`;

function probe(scenario: 'success' | 'release-failure'): Record<string, unknown> {
  const run = spawnSync('python3', ['-c', PROBE, helperDir, scenario], {
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
      ]
    });
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
      ]
    });
  });
});
