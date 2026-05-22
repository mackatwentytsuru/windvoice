import keytar from 'keytar';
import { debug } from '@main/debug';
import { isValidApiKey } from '@shared/apiKey';

const SERVICE = 'WindVoice';
const ACCOUNT = 'openai-api-key';

export class SecureStoreUnavailableError extends Error {
  code = 'SECURE_STORE_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SecureStoreUnavailableError';
  }
}

let warnedGet = false;

export class SecureStore {
  async getApiKey(): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE, ACCOUNT);
    } catch (err) {
      if (!warnedGet) {
        warnedGet = true;
        const msg = err instanceof Error ? err.message : String(err);
        debug('DICTATION', `secureStore.getApiKey unavailable: ${msg}`);
      }
      return null;
    }
  }

  async setApiKey(value: string): Promise<void> {
    if (!isValidApiKey(value)) {
      throw new Error('API key looks invalid');
    }
    const trimmed = value.trim();
    try {
      await keytar.setPassword(SERVICE, ACCOUNT, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SecureStoreUnavailableError(`secure store unavailable: ${msg}`);
    }
  }

  async clearApiKey(): Promise<void> {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SecureStoreUnavailableError(`secure store unavailable: ${msg}`);
    }
  }

  async hasApiKey(): Promise<boolean> {
    const v = await this.getApiKey();
    return !!v;
  }
}

export const secureStore = new SecureStore();
