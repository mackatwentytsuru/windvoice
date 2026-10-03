// Versioned settings migrations (#43).
//
// Per-field `.catch(default)` in SettingsSchema absorbs additive changes, but a
// rename or reshape would silently drop the user's value. Each step below
// rewrites the raw persisted object from version N to N+1 *before* Zod parses
// it. Files written before versioning existed have no `schemaVersion` and are
// treated as version 0.

import { DEFAULT_FORMATTER_MODEL, SETTINGS_SCHEMA_VERSION } from '@shared/types';

type RawSettings = Record<string, unknown>;

// Formatter models OpenAI shuts down on 2026-12-11 (gpt-5 family, incl.
// dated snapshots). Anything else the user chose is left alone.
const RETIRED_FORMATTER_MODEL_RE = /^gpt-5(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i;

/** MIGRATIONS[n] upgrades a version-n object to version n+1. */
const MIGRATIONS: ReadonlyArray<(raw: RawSettings) => RawSettings> = [
  // 0 → 1: introduce the version stamp; no field changes.
  (raw) => raw,
  // 1 → 2: move off the retired gpt-5 / gpt-5-mini formatter models.
  (raw) => {
    const formatter = raw['formatter'];
    if (!formatter || typeof formatter !== 'object' || Array.isArray(formatter)) return raw;
    const model = (formatter as Record<string, unknown>)['model'];
    if (typeof model !== 'string' || !RETIRED_FORMATTER_MODEL_RE.test(model)) return raw;
    return { ...raw, formatter: { ...formatter, model: DEFAULT_FORMATTER_MODEL } };
  }
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
