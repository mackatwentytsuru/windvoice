import { describe, expect, test } from 'vitest';
import { normalizeMessage, signatureOf } from '../src/main/report/githubReporter';
import { formatterTimeoutMs } from '../src/main/postprocess/formatter';
import { scrubSecrets } from '../src/main/debug';

describe('githubReporter signatures', () => {
  test('normalizes digits so timeout durations share one signature', () => {
    // Arrange
    const a = 'formatter timed out after 5000ms';
    const b = 'formatter timed out after 5012ms';

    // Act / Assert
    expect(normalizeMessage(a)).toBe(normalizeMessage(b));
    expect(signatureOf('formatter', a)).toBe(signatureOf('formatter', b));
  });

  test('collapses whitespace and truncates to 160 chars', () => {
    expect(normalizeMessage('  line one\n   line two\t\tend  ')).toBe('line one line two end');
    expect(normalizeMessage('x'.repeat(500)).length).toBe(160);
  });

  test('different sources produce different signatures for the same message', () => {
    const msg = 'connection closed';
    expect(signatureOf('transcription', msg)).not.toBe(signatureOf('paste', msg));
  });

  test('signature is 10 lowercase hex chars', () => {
    expect(signatureOf('duck', 'restore failed')).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe('scrubSecrets', () => {
  test('redacts sk- keys and bearer tokens', () => {
    const input = 'auth failed for sk-proj-abc123XYZ with Bearer eyJ.token-here';
    const out = scrubSecrets(input);
    expect(out).not.toContain('sk-proj-abc123XYZ');
    expect(out).not.toContain('eyJ.token-here');
    expect(out).toContain('***REDACTED***');
  });
});

describe('formatterTimeoutMs', () => {
  test('returns the 5s floor for empty input', () => {
    expect(formatterTimeoutMs(0)).toBe(5_000);
  });

  test('scales with input length (25ms per char)', () => {
    expect(formatterTimeoutMs(100)).toBe(7_500);
  });

  test('caps at 12s for very long transcripts', () => {
    expect(formatterTimeoutMs(10_000)).toBe(12_000);
  });
});
