import { describe, expect, it, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn()
}));

vi.mock('keytar', () => ({
  default: {
    getPassword: hoisted.getPassword,
    setPassword: hoisted.setPassword,
    deletePassword: hoisted.deletePassword
  }
}));

// Avoid debug() noise during tests; the secure store calls debug() on errors.
vi.mock('@main/debug', () => ({
  debug: vi.fn(),
  isDebug: vi.fn(() => false)
}));

async function freshStore(): Promise<typeof import('../src/main/store/secure')> {
  return await import('../src/main/store/secure');
}

describe('SecureStore', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.getPassword.mockReset();
    hoisted.setPassword.mockReset();
    hoisted.deletePassword.mockReset();
  });

  describe('getApiKey', () => {
    it('returns the key when keytar resolves', async () => {
      hoisted.getPassword.mockResolvedValue('sk-stored-key-1234');
      const { secureStore } = await freshStore();
      const v = await secureStore.getApiKey();
      expect(v).toBe('sk-stored-key-1234');
      expect(hoisted.getPassword).toHaveBeenCalledWith('WindVoice', 'openai-api-key');
    });

    it('returns null and does NOT throw when keytar throws (graceful fallback)', async () => {
      hoisted.getPassword.mockRejectedValue(new Error('libsecret missing'));
      const { secureStore } = await freshStore();
      await expect(secureStore.getApiKey()).resolves.toBeNull();
    });

    it('returns null when keytar resolves null', async () => {
      hoisted.getPassword.mockResolvedValue(null);
      const { secureStore } = await freshStore();
      await expect(secureStore.getApiKey()).resolves.toBeNull();
    });
  });

  describe('setApiKey', () => {
    it('rejects keys that are too short', async () => {
      const { secureStore } = await freshStore();
      await expect(secureStore.setApiKey('short')).rejects.toThrowError(/invalid/i);
      expect(hoisted.setPassword).not.toHaveBeenCalled();
    });

    it('rejects keys that are too long (>512)', async () => {
      const { secureStore } = await freshStore();
      await expect(secureStore.setApiKey('a'.repeat(513))).rejects.toThrowError(/invalid/i);
      expect(hoisted.setPassword).not.toHaveBeenCalled();
    });

    it('trims whitespace before storing', async () => {
      hoisted.setPassword.mockResolvedValue(undefined);
      const { secureStore } = await freshStore();
      await secureStore.setApiKey('  validkey1234  ');
      expect(hoisted.setPassword).toHaveBeenCalledWith(
        'WindVoice',
        'openai-api-key',
        'validkey1234'
      );
    });

    it('throws SecureStoreUnavailableError when keytar.setPassword throws', async () => {
      hoisted.setPassword.mockRejectedValue(new Error('keychain locked'));
      const { secureStore, SecureStoreUnavailableError } = await freshStore();
      await expect(secureStore.setApiKey('validkey1234')).rejects.toBeInstanceOf(
        SecureStoreUnavailableError
      );
    });

    it('the SecureStoreUnavailableError carries the underlying message', async () => {
      hoisted.setPassword.mockRejectedValue(new Error('keychain locked'));
      const { secureStore } = await freshStore();
      await expect(secureStore.setApiKey('validkey1234')).rejects.toThrowError(/keychain locked/);
    });
  });

  describe('clearApiKey', () => {
    it('calls keytar.deletePassword on the right service/account', async () => {
      hoisted.deletePassword.mockResolvedValue(true);
      const { secureStore } = await freshStore();
      await secureStore.clearApiKey();
      expect(hoisted.deletePassword).toHaveBeenCalledWith('WindVoice', 'openai-api-key');
    });

    it('throws SecureStoreUnavailableError when keytar.deletePassword throws', async () => {
      hoisted.deletePassword.mockRejectedValue(new Error('keychain locked'));
      const { secureStore, SecureStoreUnavailableError } = await freshStore();
      await expect(secureStore.clearApiKey()).rejects.toBeInstanceOf(SecureStoreUnavailableError);
    });
  });

  describe('hasApiKey', () => {
    it('returns true when getApiKey returns a non-empty string', async () => {
      hoisted.getPassword.mockResolvedValue('sk-something');
      const { secureStore } = await freshStore();
      await expect(secureStore.hasApiKey()).resolves.toBe(true);
    });

    it('returns false when getApiKey returns null', async () => {
      hoisted.getPassword.mockResolvedValue(null);
      const { secureStore } = await freshStore();
      await expect(secureStore.hasApiKey()).resolves.toBe(false);
    });

    it('returns false when keytar throws (gracefully)', async () => {
      hoisted.getPassword.mockRejectedValue(new Error('boom'));
      const { secureStore } = await freshStore();
      await expect(secureStore.hasApiKey()).resolves.toBe(false);
    });
  });

  describe('SecureStoreUnavailableError', () => {
    it('is exported and instanceof works', async () => {
      const { SecureStoreUnavailableError } = await freshStore();
      const err = new SecureStoreUnavailableError('nope');
      expect(err).toBeInstanceOf(SecureStoreUnavailableError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('SecureStoreUnavailableError');
      expect(err.code).toBe('SECURE_STORE_UNAVAILABLE');
    });
  });
});
