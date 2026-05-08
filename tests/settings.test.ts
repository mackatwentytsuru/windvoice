import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '../src/shared/types';

describe('SettingsSchema', () => {
  it('parses an empty object into well-formed defaults', () => {
    const s = SettingsSchema.parse({});
    expect(s.hotkeys).toHaveLength(1);
    expect(s.hotkeys[0]?.mode).toBe('push-to-talk');
    expect(s.hotkeys[0]?.keys).toEqual(['RightAlt']);
    expect(s.language).toBe('ja');
    expect(s.formatter.model).toBe('gpt-5-mini');
    expect(s.insertion.method).toBe('paste');
    expect(s.dictionary).toEqual([]);
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

  it('rejects an empty key list', () => {
    expect(() =>
      SettingsSchema.parse({ hotkeys: [{ id: 'bad', keys: [], mode: 'toggle' }] })
    ).toThrow();
  });

  it('clamps audio inputGain to [0, 4]', () => {
    expect(() => SettingsSchema.parse({ audio: { inputGain: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ audio: { inputGain: 5 } })).toThrow();
    expect(SettingsSchema.parse({ audio: { inputGain: 2 } }).audio.inputGain).toBe(2);
  });

  it('rejects unknown insertion method', () => {
    expect(() =>
      SettingsSchema.parse({ insertion: { method: 'magic' } })
    ).toThrow();
  });
});
