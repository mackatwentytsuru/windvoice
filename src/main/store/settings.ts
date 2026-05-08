import Store from 'electron-store';
import { SettingsSchema, type Settings } from '@shared/types';

class SettingsStore {
  private store: Store<Settings>;

  constructor() {
    const defaults = SettingsSchema.parse({});
    this.store = new Store<Settings>({
      name: 'windvoice-settings',
      defaults,
      clearInvalidConfig: true
    });
  }

  get(): Settings {
    const raw = this.store.store;
    const parsed = SettingsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const defaults = SettingsSchema.parse({});
    this.store.store = defaults;
    return defaults;
  }

  set(partial: Partial<Settings>): Settings {
    const merged = { ...this.get(), ...partial };
    const parsed = SettingsSchema.parse(merged);
    this.store.store = parsed;
    return parsed;
  }

  reset(): Settings {
    const defaults = SettingsSchema.parse({});
    this.store.store = defaults;
    return defaults;
  }
}

export const settingsStore = new SettingsStore();
