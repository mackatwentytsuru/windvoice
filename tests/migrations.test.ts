import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../src/main/store/migrations';
import {
  DEFAULT_FORMATTER_MODEL,
  SETTINGS_SCHEMA_VERSION,
  SettingsSchema
} from '../src/shared/types';

describe('migrateSettings (#43)', () => {
  it('stamps unversioned files with the current version and keeps fields', () => {
    const { value, changed } = migrateSettings({ language: 'ja' });
    expect(changed).toBe(true);
    expect(value).toMatchObject({ language: 'ja', schemaVersion: SETTINGS_SCHEMA_VERSION });
  });

  it('leaves current and newer files untouched', () => {
    const current = { schemaVersion: SETTINGS_SCHEMA_VERSION };
    expect(migrateSettings(current)).toEqual({ value: current, changed: false });
    const newer = { schemaVersion: SETTINGS_SCHEMA_VERSION + 5 };
    expect(migrateSettings(newer)).toEqual({ value: newer, changed: false });
  });

  it('passes non-objects through for Zod to reject', () => {
    expect(migrateSettings(null)).toEqual({ value: null, changed: false });
  });

  it('moves retired gpt-5 / gpt-5-mini formatter models to the default', () => {
    for (const model of ['gpt-5-mini', 'gpt-5', 'gpt-5-mini-2025-08-07']) {
      const { value } = migrateSettings({ formatter: { model, enabled: false } });
      expect(value).toMatchObject({
        formatter: { model: DEFAULT_FORMATTER_MODEL, enabled: false }
      });
    }
  });

  it('keeps any other formatter model the user picked', () => {
    for (const model of ['gpt-5.4-mini', 'gpt-4o-mini', 'gpt-5-nano']) {
      const { value } = migrateSettings({ formatter: { model } });
      expect(value).toMatchObject({ formatter: { model } });
    }
  });

  it('moves the short-lived v2 default gpt-5.6-luna forward (2 → 3)', () => {
    const { value } = migrateSettings({ schemaVersion: 2, formatter: { model: 'gpt-5.6-luna' } });
    expect(value).toMatchObject({ formatter: { model: DEFAULT_FORMATTER_MODEL } });
  });

  it('does not re-migrate a current-version file', () => {
    const v2 = { schemaVersion: SETTINGS_SCHEMA_VERSION, formatter: { model: 'gpt-5-mini' } };
    expect(migrateSettings(v2)).toEqual({ value: v2, changed: false });
  });

  it('defaults schemaVersion in a fresh parse', () => {
    expect(SettingsSchema.parse({}).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });
});
