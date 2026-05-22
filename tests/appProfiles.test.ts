import { describe, it, expect } from 'vitest';
import { SettingsSchema } from '@shared/types';
import { buildSystemPrompt } from '@main/postprocess/formatter';

describe('per-app formatter profiles', () => {
  it('appends a matching profile instructions to the system prompt', () => {
    const settings = SettingsSchema.parse({
      formatter: {
        appProfiles: [{ match: 'Terminal', instructions: 'Be terse, no markdown.' }]
      }
    });
    expect(buildSystemPrompt(settings, 'Windows Terminal')).toContain('Be terse, no markdown.');
  });

  it('does not append anything when no app matches (or app is unknown)', () => {
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'Terminal', instructions: 'Be terse.' }] }
    });
    expect(buildSystemPrompt(settings, 'Google Chrome')).not.toContain('Be terse.');
    expect(buildSystemPrompt(settings, undefined)).not.toContain('Be terse.');
  });

  it('matches case-insensitively on a substring of the app name', () => {
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'code', instructions: 'Technical tone.' }] }
    });
    expect(buildSystemPrompt(settings, 'Visual Studio Code')).toContain('Technical tone.');
  });

  it('uses the first matching profile', () => {
    const settings = SettingsSchema.parse({
      formatter: {
        appProfiles: [
          { match: 'slack', instructions: 'FIRST casual.' },
          { match: 'slack', instructions: 'SECOND formal.' }
        ]
      }
    });
    const prompt = buildSystemPrompt(settings, 'Slack');
    expect(prompt).toContain('FIRST casual.');
    expect(prompt).not.toContain('SECOND formal.');
  });
});
