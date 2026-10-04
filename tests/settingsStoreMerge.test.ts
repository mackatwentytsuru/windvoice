import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Conf from 'conf';
import { migrateSettings, storeDefaults } from '../src/main/store/migrations';
import { DEFAULT_FORMATTER_MODEL, SETTINGS_SCHEMA_VERSION, SettingsSchema } from '../src/shared/types';

// electron-store is a thin Electron wrapper around `conf`; this exercises the
// real constructor-time defaults merge that broke migration in 0.1.15/0.1.16.
describe('settings file from 0.1.14 opened through the real store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is migrated to the current formatter model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-settings-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'windvoice-settings.json'),
      JSON.stringify({
        language: 'ja',
        formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: true }
      })
    );

    const store = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: 'windvoice-settings',
      projectName: 'windvoice-test',
      defaults: storeDefaults()
    });
    expect(store.store).not.toHaveProperty('schemaVersion');

    const migrated = migrateSettings(store.store);
    const parsed = SettingsSchema.parse(migrated.value);
    expect(migrated.changed).toBe(true);
    expect(parsed.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(parsed.formatter.model).toBe(DEFAULT_FORMATTER_MODEL);
    expect(parsed.formatter.fastPath).toBe(true);
  });

  it('(regression proof) seeding the full defaults stamps the version and skips migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-settings-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'windvoice-settings.json'),
      JSON.stringify({ formatter: { model: 'gpt-5-mini', customInstructions: '', enabled: true } })
    );
    // What 0.1.15/0.1.16 did: defaults included schemaVersion.
    const store = new Conf<Record<string, unknown>>({
      cwd: dir,
      configName: 'windvoice-settings',
      projectName: 'windvoice-test',
      defaults: SettingsSchema.parse({}) as unknown as Record<string, unknown>
    });
    expect(store.store['schemaVersion']).toBe(SETTINGS_SCHEMA_VERSION);
    expect(migrateSettings(store.store).changed).toBe(false);
  });
});
