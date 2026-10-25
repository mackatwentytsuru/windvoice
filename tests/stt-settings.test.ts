import { describe, expect, it } from 'vitest';
import { SettingsSchema, LocalSttSettingsSchema } from '../src/shared/types';

describe('stt settings', () => {
  it('defaults to the OpenAI engine and the bundled local server', () => {
    const s = SettingsSchema.parse({});
    expect(s.stt.engine).toBe('openai');
    expect(s.stt.localUrl).toBe('http://127.0.0.1:5312');
    expect(s.stt.autoStart).toBe(true);
    expect(s.stt.threads).toBe(4);
    expect(s.stt.serverScript).toBe('resources/stt/sherpa_server.py');
    expect(s.stt.modelDir).toBe('');
    expect(s.stt.pythonPath).toBe('python');
  });

  it('keeps an existing (pre-stt) settings file loading unchanged', () => {
    // A settings file written by an older version has no `stt` key.
    const legacy = {
      hotkeys: [{ id: 'primary', keys: ['RightCtrl'], mode: 'push-to-talk', format: true }],
      language: 'ja',
      formatter: { model: 'gpt-5-mini', enabled: true },
      dictionary: [],
      insertion: { method: 'paste', restoreClipboard: true, streaming: false },
      ui: { uiLanguage: 'ja', autoLaunch: false }
    };
    const parsed = SettingsSchema.parse(legacy);
    expect(parsed.stt.engine).toBe('openai'); // existing users see no change
    expect(parsed.language).toBe('ja');
    expect(parsed.ui.uiLanguage).toBe('ja');
    expect(parsed.formatter.model).toBe('gpt-5-mini');
  });

  it('fills missing stt sub-fields with defaults', () => {
    const parsed = SettingsSchema.parse({ stt: { engine: 'local' } });
    expect(parsed.stt.engine).toBe('local');
    expect(parsed.stt.localUrl).toBe('http://127.0.0.1:5312');
    expect(parsed.stt.autoStart).toBe(true);
    expect(parsed.stt.threads).toBe(4);
  });

  it('preserves a configured local engine', () => {
    const parsed = LocalSttSettingsSchema.parse({
      engine: 'local',
      localUrl: 'http://127.0.0.1:6000',
      autoStart: false,
      pythonPath: 'D:/stt/venv/Scripts/python.exe',
      modelDir: 'D:/stt/models/parakeet',
      threads: 8
    });
    expect(parsed).toMatchObject({
      engine: 'local',
      localUrl: 'http://127.0.0.1:6000',
      autoStart: false,
      pythonPath: 'D:/stt/venv/Scripts/python.exe',
      modelDir: 'D:/stt/models/parakeet',
      threads: 8
    });
  });

  it('falls back to openai for an unknown engine value', () => {
    expect(SettingsSchema.parse({ stt: { engine: 'azure' } }).stt.engine).toBe('openai');
  });

  it('clamps an out-of-range thread count to the default (never fails the file)', () => {
    expect(SettingsSchema.parse({ stt: { threads: 0 } }).stt.threads).toBe(4);
    expect(SettingsSchema.parse({ stt: { threads: 999 } }).stt.threads).toBe(4);
  });
});
