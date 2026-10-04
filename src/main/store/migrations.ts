// Versioned settings migrations (#43).
//
// Per-field `.catch(default)` in SettingsSchema absorbs additive changes, but a
// rename or reshape would silently drop the user's value. Each step below
// rewrites the raw persisted object from version N to N+1 *before* Zod parses
// it. Files written before versioning existed have no `schemaVersion` and are
// treated as version 0.
//
// The store must NOT seed `schemaVersion` from its defaults (see
// storeDefaults): electron-store shallow-merges defaults into the file on
// construction, which stamped pre-versioning files as current before these
// steps ever ran.

import { DEFAULT_FORMATTER_MODEL, SETTINGS_SCHEMA_VERSION, SettingsSchema } from '@shared/types';

type RawSettings = Record<string, unknown>;

// Formatter models OpenAI shuts down on 2026-12-11 (gpt-5 family, incl.
// dated snapshots), plus gpt-5.6-luna, the short-lived v2 default. There is
// no model picker in the UI, so these only ever came from an old default or a
// hand edit. Anything else is left alone.
const SUPERSEDED_FORMATTER_MODEL_RE = /^(?:gpt-5(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|gpt-5\.6-luna)$/i;

function moveToCurrentFormatterModel(raw: RawSettings): RawSettings {
  const formatter = raw['formatter'];
  if (!formatter || typeof formatter !== 'object' || Array.isArray(formatter)) return raw;
  const model = (formatter as Record<string, unknown>)['model'];
  if (typeof model !== 'string' || !SUPERSEDED_FORMATTER_MODEL_RE.test(model)) return raw;
  return { ...raw, formatter: { ...formatter, model: DEFAULT_FORMATTER_MODEL } };
}

/** MIGRATIONS[n] upgrades a version-n object to version n+1. */
const MIGRATIONS: ReadonlyArray<(raw: RawSettings) => RawSettings> = [
  // 0 → 1: introduce the version stamp; no field changes.
  (raw) => raw,
  // 1 → 2: move off the retired gpt-5 / gpt-5-mini formatter models.
  moveToCurrentFormatterModel,
  // 2 → 3: the short-lived v2 default gpt-5.6-luna → gpt-6-luna.
  moveToCurrentFormatterModel,
  // 3 → 4: repair files that 0.1.15/0.1.16 stamped as v3 *before* migrating
  // (the electron-store defaults merge above), which left upgraders from
  // 0.1.14 on gpt-5-mini / gpt-5.6-luna. Idempotent for correctly migrated
  // files.
  moveToCurrentFormatterModel
];

export function migrateSettings(raw: unknown): { value: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: raw, changed: false };
  }
  let next: RawSettings = { ...(raw as RawSettings) };
  const stored = next['schemaVersion'];
  let version = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  // A file from a newer build (downgrade): leave it for Zod to read leniently.
  if (version >= SETTINGS_SCHEMA_VERSION) return { value: raw, changed: false };
  while (version < SETTINGS_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step) next = step(next);
    version++;
  }
  next['schemaVersion'] = SETTINGS_SCHEMA_VERSION;
  return { value: next, changed: true };
}

/**
 * Defaults for the electron-store constructor. `schemaVersion` is left out on
 * purpose: the store shallow-merges defaults into an existing file, and a
 * seeded version would mark an unmigrated file as current. A fresh install
 * gets its stamp from migrateSettings() on the first get().
 */
export function storeDefaults(): RawSettings {
  const { schemaVersion: _omitted, ...rest } = SettingsSchema.parse({});
  return rest;
}
