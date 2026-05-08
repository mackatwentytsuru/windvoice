import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// The `debug` module reads process.env when it's first imported AND on every
// call (channel-specific check). To get a clean slate per test we
// `vi.resetModules()` and re-import.
async function freshDebug(): Promise<typeof import('../src/main/debug')> {
  return await import('../src/main/debug');
}

describe('debug()', () => {
  const originalEnv = process.env;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['WINDVOICE_DEBUG'];
    for (const d of ['HOTKEY', 'AUDIO', 'REALTIME', 'DICTATION', 'DUCK', 'OVERLAY']) {
      delete process.env[`WINDVOICE_DEBUG_${d}`];
    }
    vi.resetModules();
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    writeSpy.mockRestore();
  });

  it('writes to stderr when WINDVOICE_DEBUG=1 is set', async () => {
    process.env['WINDVOICE_DEBUG'] = '1';
    const { debug } = await freshDebug();
    debug('DICTATION', 'hello');
    expect(writeSpy).toHaveBeenCalled();
    const out = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(out).toContain('hello');
    expect(out).toContain('[dictation]');
  });

  it('writes to stderr when channel-specific env var is set', async () => {
    process.env['WINDVOICE_DEBUG_DUCK'] = '1';
    const { debug } = await freshDebug();
    debug('DUCK', 'lowering');
    expect(writeSpy).toHaveBeenCalled();
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('lowering');
  });

  it('writes nothing when no debug flag is set', async () => {
    const { debug } = await freshDebug();
    debug('DICTATION', 'silent');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not write to OTHER channels when only one channel is enabled', async () => {
    process.env['WINDVOICE_DEBUG_HOTKEY'] = '1';
    const { debug } = await freshDebug();
    debug('AUDIO', 'audio msg');
    expect(writeSpy).not.toHaveBeenCalled();
    debug('HOTKEY', 'hotkey msg');
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('scrubs sk- API keys', async () => {
    process.env['WINDVOICE_DEBUG'] = '1';
    const { debug } = await freshDebug();
    debug('DICTATION', 'using sk-abcdef1234567890');
    expect(writeSpy).toHaveBeenCalled();
    const out = String(writeSpy.mock.calls[0]?.[0]);
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('sk-abcdef1234567890');
  });

  it('scrubs Authorization Bearer tokens', async () => {
    process.env['WINDVOICE_DEBUG'] = '1';
    const { debug } = await freshDebug();
    debug('DICTATION', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIs');
    expect(writeSpy).toHaveBeenCalled();
    const out = String(writeSpy.mock.calls[0]?.[0]);
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIs');
    // The literal token portion of "Bearer <token>" must not appear.
    expect(out).not.toMatch(/Bearer\s+eyJhbGciOiJIUzI1NiIs/);
  });

  it('scrubs multiple sk- occurrences in one message', async () => {
    process.env['WINDVOICE_DEBUG'] = '1';
    const { debug } = await freshDebug();
    debug('DICTATION', 'first sk-aaaaaaaa1234 then sk-bbbbbbbb5678 done');
    const out = String(writeSpy.mock.calls[0]?.[0]);
    expect(out).not.toContain('sk-aaaaaaaa1234');
    expect(out).not.toContain('sk-bbbbbbbb5678');
    // Both should be replaced.
    const matches = out.match(/\*\*\*REDACTED\*\*\*/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('passes a normal message through untouched', async () => {
    process.env['WINDVOICE_DEBUG'] = '1';
    const { debug } = await freshDebug();
    debug('DICTATION', 'just a plain message');
    expect(writeSpy).toHaveBeenCalled();
    const out = String(writeSpy.mock.calls[0]?.[0]);
    expect(out).toContain('just a plain message');
    expect(out).not.toContain('***REDACTED***');
  });

  it('isDebug() reports the same enable state', async () => {
    process.env['WINDVOICE_DEBUG_AUDIO'] = '1';
    const { isDebug } = await freshDebug();
    expect(isDebug('AUDIO')).toBe(true);
    expect(isDebug('HOTKEY')).toBe(false);
  });
});
