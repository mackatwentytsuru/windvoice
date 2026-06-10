import { describe, it, expect } from 'vitest';
import { APP_PROFILE_INSTRUCTIONS_MAX, SettingsSchema, type Settings } from '@shared/types';
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

  it('matches case-insensitively on a word-boundary substring of the app name', () => {
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'code', instructions: 'Technical tone.' }] }
    });
    expect(buildSystemPrompt(settings, 'Visual Studio Code')).toContain('Technical tone.');
  });

  it('does NOT match when the profile token is embedded inside a longer word', () => {
    // Hardening: a bare substring test let profile "code" match
    // "decode.exe" — over-matching and spoofable by any app whose name
    // merely embeds the token.
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'code', instructions: 'Technical tone.' }] }
    });
    expect(buildSystemPrompt(settings, 'decode')).not.toContain('Technical tone.');
    expect(buildSystemPrompt(settings, 'decode.exe')).not.toContain('Technical tone.');
    expect(buildSystemPrompt(settings, 'barcoder')).not.toContain('Technical tone.');
  });

  it('strips a trailing .exe from both the app name and the profile match', () => {
    const settings = SettingsSchema.parse({
      formatter: {
        appProfiles: [
          { match: 'Code', instructions: 'For VS Code.' },
          { match: 'msedge.exe', instructions: 'For Edge.' }
        ]
      }
    });
    // Windows process name ↔ bare profile token.
    expect(buildSystemPrompt(settings, 'Code.exe')).toContain('For VS Code.');
    // Profile typed with .exe ↔ app reported without it.
    expect(buildSystemPrompt(settings, 'msedge')).toContain('For Edge.');
  });

  it('treats regex metacharacters in the profile match as literals', () => {
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'c++ builder', instructions: 'CPP tone.' }] }
    });
    expect(buildSystemPrompt(settings, 'C++ Builder')).toContain('CPP tone.');
    expect(buildSystemPrompt(settings, 'cxx builder')).not.toContain('CPP tone.');
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

  it('clamps over-long instructions at the settings boundary', () => {
    // Prompt-injection-via-config-import surface: instructions flow
    // verbatim into the LLM system prompt, so the schema clamps (not
    // rejects — a rejection would reset ALL settings via the safeParse →
    // defaults path in store/settings.ts) anything past the cap.
    const oversized = 'x'.repeat(APP_PROFILE_INSTRUCTIONS_MAX + 500);
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'slack', instructions: oversized }] }
    });
    expect(settings.formatter.appProfiles[0]!.instructions).toHaveLength(
      APP_PROFILE_INSTRUCTIONS_MAX
    );
  });

  it('truncates over-long instructions at use even when the schema was bypassed', () => {
    // Defense in depth: a hand-edited settings file or an older app
    // version can hand the formatter a Settings object that never went
    // through the current schema. buildSystemPrompt must cap it anyway.
    const oversized = `${'y'.repeat(APP_PROFILE_INSTRUCTIONS_MAX)}INJECTED-TAIL`;
    const settings = SettingsSchema.parse({
      formatter: { appProfiles: [{ match: 'slack', instructions: 'placeholder' }] }
    }) as Settings;
    settings.formatter.appProfiles[0]!.instructions = oversized;
    const prompt = buildSystemPrompt(settings, 'Slack');
    expect(prompt).toContain('y'.repeat(100));
    expect(prompt).not.toContain('INJECTED-TAIL');
  });
});
