import Store from 'electron-store';
import { SettingsSchema, type Settings } from '@shared/types';
import { migrateSettings } from '@main/store/migrations';
import { enforcePrivateFileMode } from '@main/store/privateMode';

class SettingsStore {
  private store: Store<Settings>;
  // Cached parsed settings. `settingsStore.get()` is called many times per
  // dictation cycle (orchestrator pre-flight, audio device check, hotkey
  // settings push, formatter dispatch, paste path, post-paste cleanup). The
  // underlying electron-store read returns a fresh object that `safeParse`
  // would otherwise re-validate every time. Cache the validated value and
  // invalidate it on any mutation path.
  private cached: Settings | null = null;

  constructor() {
    const defaults = SettingsSchema.parse({});
    this.store = new Store<Settings>({
      name: 'windvoice-settings',
      defaults,
      clearInvalidConfig: true
    });
    enforcePrivateFileMode(this.store.path);
  }

  get(): Settings {
    if (this.cached) return this.cached;
    const migrated = migrateSettings(this.store.store);
    const parsed = SettingsSchema.safeParse(migrated.value);
    if (parsed.success) {
      if (migrated.changed) {
        this.store.store = parsed.data;
        enforcePrivateFileMode(this.store.path);
      }
      this.cached = parsed.data;
      return parsed.data;
    }
    const defaults = SettingsSchema.parse({});
    this.store.store = defaults;
    enforcePrivateFileMode(this.store.path);
    this.cached = defaults;
    return defaults;
  }

  set(partial: Partial<Settings>): Settings {
    const merged = { ...this.get(), ...partial };
    const parsed = SettingsSchema.parse(merged);
    this.store.store = parsed;
    enforcePrivateFileMode(this.store.path);
    this.cached = parsed;
    return parsed;
  }

  reset(): Settings {
    const defaults = SettingsSchema.parse({});
    this.store.store = defaults;
    enforcePrivateFileMode(this.store.path);
    this.cached = defaults;
    return defaults;
  }
}

export const settingsStore = new SettingsStore();
