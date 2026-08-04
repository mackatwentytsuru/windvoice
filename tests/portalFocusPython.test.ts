import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helperDir = path.resolve('resources/native');

const PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_focus import focused_app_id

class Variant:
    def __init__(self, value):
        self.value = value

    def unpack(self):
        return self.value

scenario = sys.argv[2]

if scenario == 'focused':
    windows = Variant({
        7: {
            'app-id': Variant('org.gnome.Terminal.desktop'),
            'has-focus': Variant(False),
        },
        9: {
            'app-id': Variant('com.anthropic.Claude.desktop'),
            'has-focus': Variant(True),
        },
    })
    getter = lambda: windows
elif scenario == 'denied':
    def getter():
        raise RuntimeError('GDBus.Error:org.freedesktop.DBus.Error.AccessDenied')
else:
    getter = lambda: Variant({})

print(json.dumps({'appId': focused_app_id(getter)}))
`;

const DBUS_PROBE = String.raw`
import ast
import json
import sys

source_path = sys.argv[1]
tree = ast.parse(open(source_path, encoding='utf-8').read(), source_path)
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == 'get_focused_app_id'
)
module = ast.Module(body=[function], type_ignores=[])
calls = []

class Result:
    def unpack(self):
        return ({},)

class Bus:
    def call_sync(self, *args):
        calls.append(args)
        return Result()

class FakeGLib:
    @staticmethod
    def Variant(signature, value):
        return [signature, value]

    @staticmethod
    def VariantType(signature):
        return signature

def focused_app_id(get_windows):
    get_windows()
    return 'unknown'

namespace = {
    'bus': Bus(),
    'GNOME_INTROSPECT': 'org.gnome.Shell.Introspect',
    'GNOME_INTROSPECT_PATH': '/org/gnome/Shell/Introspect',
    'GLib': FakeGLib,
    'focused_app_id': focused_app_id,
}
exec(compile(module, source_path, 'exec'), namespace)
result = namespace['get_focused_app_id']()
call = calls[0]
print(json.dumps({
    'result': result,
    'destination': call[0],
    'path': call[1],
    'interface': call[2],
    'method': call[3],
    'resultType': call[5],
}))
`;

function probe(scenario: 'focused' | 'denied' | 'empty'): string {
  const run = spawnSync('python3', ['-c', PROBE, helperDir, scenario], {
    encoding: 'utf8'
  });
  expect(run.status, run.stderr).toBe(0);
  return (JSON.parse(run.stdout) as { appId: string }).appId;
}

describe('GNOME Shell focused application introspection', () => {
  it('returns the focused window app-id from wrapped D-Bus variants', () => {
    expect(probe('focused')).toBe('com.anthropic.Claude.desktop');
  });

  it('reports unknown when GetWindows is denied or has no focused window', () => {
    expect(probe('denied')).toBe('unknown');
    expect(probe('empty')).toBe('unknown');
  });

  it('uses the GNOME Shell Introspect GetWindows D-Bus contract', () => {
    const source = path.resolve('resources/native/portal-remote.py');
    const run = spawnSync('python3', ['-c', DBUS_PROBE, source], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      result: 'unknown',
      destination: 'org.gnome.Shell.Introspect',
      path: '/org/gnome/Shell/Introspect',
      interface: 'org.gnome.Shell.Introspect',
      method: 'GetWindows',
      resultType: '(a{ta{sv}})'
    });
  });
});
