import keytar from 'keytar';

const SERVICE = 'WindVoice';
const ACCOUNT = 'openai-api-key';

export class SecureStore {
  async getApiKey(): Promise<string | null> {
    return keytar.getPassword(SERVICE, ACCOUNT);
  }

  async setApiKey(value: string): Promise<void> {
    if (!value || value.length < 10) {
      throw new Error('API key looks invalid');
    }
    await keytar.setPassword(SERVICE, ACCOUNT, value);
  }

  async clearApiKey(): Promise<void> {
    await keytar.deletePassword(SERVICE, ACCOUNT);
  }

  async hasApiKey(): Promise<boolean> {
    const v = await this.getApiKey();
    return !!v;
  }
}

export const secureStore = new SecureStore();
