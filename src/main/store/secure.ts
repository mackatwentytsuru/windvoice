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

/**
 * LOW: a rejected API key is a BAD-INPUT condition, not a keyring failure.
 * Throwing a distinct error lets the IPC handler classify it as 'E_INVALID'
 * instead of the misleading 'E_SECURE_STORE' (which previously surfaced a
 * whitespace-padded too-short key as a keychain/keyring fault).
 */
export class InvalidApiKeyError extends Error {
  code = 'E_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApiKeyError';
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
      throw new InvalidApiKeyError('API key looks invalid');
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
