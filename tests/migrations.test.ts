import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../src/main/store/migrations';
import { SETTINGS_SCHEMA_VERSION, SettingsSchema } from '../src/shared/types';

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

  it('defaults schemaVersion in a fresh parse', () => {
    expect(SettingsSchema.parse({}).schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });
});
