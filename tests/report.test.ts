import { describe, expect, test, vi } from 'vitest';

vi.mock('@main/store/settings', () => ({
  settingsStore: {
    get: () => ({
      ui: {
        errorReporting: false,
        errorReportingConsent: 'undecided',
        errorReportingPrompted: false
      }
    }),
    set: vi.fn()
  }
}));

vi.mock('@main/ipc/handlers', () => ({
  refuseUntrusted: () => null
}));
import {
  filterAllowedLogLines,
  mergeReportOccurrence,
  normalizeMessage,
  rateLimitCreates,
  resolveReportingPreference,
  signatureOf
} from '../src/main/report/githubReporter';
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

describe('githubReporter privacy and queue guards', () => {
  test('keeps an unconsented default in local-preview-only mode', () => {
    expect(
      resolveReportingPreference({
        errorReporting: false,
        errorReportingConsent: 'undecided'
      })
    ).toBe('undecided');
    expect(
      resolveReportingPreference({
        errorReporting: false,
        errorReportingConsent: 'disabled'
      })
    ).toBe('disabled');
  });

  test('keeps only explicitly allowed diagnostic log lines and excludes raw key events', () => {
    const raw = [
      '2026-07-29T10:00:00.000Z [realtime] audio backpressure drop',
      '2026-07-29T10:00:01.000Z [hotkey] evdev down code=30 value=1',
      '2026-07-29T10:00:02.000Z [hotkey] down keycode=30 alt=false ctrl=false',
      '2026-07-29T10:00:03.000Z [dictation] delivered=12 chunks maxLevel=0.2310',
      '2026-07-29T10:00:04.000Z [dictation] transcript=private words'
    ].join('\n');

    const filtered = filterAllowedLogLines(raw);

    expect(filtered).toContain('audio backpressure drop');
    expect(filtered).toContain('delivered=12 chunks');
    expect(filtered).not.toContain('evdev');
    expect(filtered).not.toContain('keycode');
    expect(filtered).not.toContain('private words');
  });

  test('deduplicates occurrences by normalized signature', () => {
    const first = mergeReportOccurrence(
      {},
      'updater',
      'request timed out after 5000ms',
      '2026-07-29T10:00:00.000Z',
      'preview one'
    );
    const second = mergeReportOccurrence(
      first.state,
      'updater',
      'request timed out after 5012ms',
      '2026-07-29T10:05:00.000Z',
      'preview two'
    );

    expect(second.signature).toBe(first.signature);
    expect(Object.keys(second.state)).toHaveLength(1);
    expect(second.state[second.signature]?.count).toBe(2);
  });

  test('limits new issue creates to five per rolling hour', () => {
    const hour = 60 * 60 * 1000;
    const now = 10 * hour;
    const timestamps = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];

    expect(rateLimitCreates(timestamps, now).allowed).toBe(false);
    expect(rateLimitCreates([now - hour - 1, ...timestamps.slice(1)], now).allowed).toBe(true);
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
