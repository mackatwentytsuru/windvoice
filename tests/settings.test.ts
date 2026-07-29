import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../src/shared/types';

describe('SettingsSchema', () => {
  it('parses an empty object into well-formed defaults', () => {
    const s = SettingsSchema.parse({});
    expect(s.hotkeys).toHaveLength(1);
    expect(s.hotkeys[0]?.mode).toBe('push-to-talk');
    expect(s.hotkeys[0]?.keys).toEqual(['RightCtrl']);
    expect(s.language).toBe('ja');
    expect(s.formatter.model).toBe('gpt-5-mini');
    expect(s.insertion.method).toBe('paste');
    expect(s.dictionary).toEqual([]);
    expect(s.ui.errorReporting).toBe(false);
    expect(s.ui.errorReportingConsent).toBe('undecided');
  });

  it('preserves user-supplied hotkeys', () => {
    const s = SettingsSchema.parse({
      hotkeys: [
        { id: 'longform', keys: ['Ctrl', 'Shift', 'Space'], mode: 'toggle' }
      ]
    });
    expect(s.hotkeys).toHaveLength(1);
    expect(s.hotkeys[0]?.mode).toBe('toggle');
    expect(s.hotkeys[0]?.format).toBe(true); // default applied
  });

  // v0.1.2: an invalid hotkeys array (e.g. one entry with `keys: []`) no longer
  // throws — the schema falls back to the default RightCtrl binding via
  // `.catch(() => defaultHotkeyBindings())`. This keeps a corrupted settings
  // file from bricking the app on launch.
  it('falls back to default hotkey when an entry has an empty key list', () => {
    const parsed = SettingsSchema.parse({
      hotkeys: [{ id: 'bad', keys: [], mode: 'toggle' }]
    });
    expect(parsed.hotkeys).toHaveLength(1);
    expect(parsed.hotkeys[0]?.keys).toEqual(['RightCtrl']);
    expect(parsed.hotkeys[0]?.mode).toBe('push-to-talk');
    expect(parsed.hotkeys[0]?.id).toBe('primary');
  });

  // v0.1.2: `audio.inputGain` was scaffolded but never wired into the
  // AudioWorklet pipeline (#16) and has been removed from the schema. Zod
  // ignores unknown properties unless `.strict()` is used, so existing
  // settings files with `inputGain` still parse — the field is simply dropped.
  it('drops the deprecated audio.inputGain field without throwing', () => {
    const parsed = SettingsSchema.parse({ audio: { inputGain: 2, device: 'mic-1' } });
    expect(parsed.audio.device).toBe('mic-1');
    // `inputGain` is not in the parsed audio object.
    expect(Object.keys(parsed.audio)).toEqual(['device']);
  });

  // v0.1.2: 'type' was removed as an insertion method (#6). The enum is now
  // a single-member literal with `.catch('paste')`, so any legacy/unknown
  // value parses to 'paste' instead of failing schema validation.
  it('falls back to paste for unknown insertion methods', () => {
    const parsed = SettingsSchema.parse({ insertion: { method: 'magic' } });
    expect(parsed.insertion.method).toBe('paste');
  });

  // MEDIUM: one out-of-range nested scalar must NOT nuke every other setting.
  // Each nested scalar now has a field-level `.catch(default)`, so a bad
  // `ui.duckLevel` (out of [0,1]) is repaired to its own default while the
  // user's custom hotkeys / other fields are preserved. Previously a single
  // bad field failed the whole-object safeParse in store/settings.ts and
  // reset EVERYTHING to defaults.
  it('repairs one out-of-range nested field without resetting other settings', () => {
    const parsed = SettingsSchema.parse({
      hotkeys: [{ id: 'longform', keys: ['Ctrl', 'Shift', 'Space'], mode: 'toggle' }],
      language: 'en',
      ui: { duckLevel: 1.5 }
    });
    // The user's other settings survive untouched.
    expect(parsed.hotkeys).toHaveLength(1);
    expect(parsed.hotkeys[0]?.mode).toBe('toggle');
    expect(parsed.hotkeys[0]?.keys).toEqual(['Ctrl', 'Shift', 'Space']);
    expect(parsed.language).toBe('en');
    // Only the bad field is repaired to its own default.
    expect(parsed.ui.duckLevel).toBe(0.3);
  });

  // MEDIUM: an out-of-enum nested scalar also repairs to its own default
  // instead of failing the whole parse.
  it('repairs an invalid ui.theme enum value to its default', () => {
    const parsed = SettingsSchema.parse({ ui: { theme: 'neon' } });
    expect(parsed.ui.theme).toBe('system');
  });
});
