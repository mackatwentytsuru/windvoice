import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptLearningLog } from '../src/main/dictionary/transcriptLog';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TranscriptLearningLog', () => {
  it('does nothing unless the user explicitly opts in', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'windvoice-transcript-'));
    dirs.push(dir);
    const file = path.join(dir, 'transcript-learning.jsonl');
    const log = new TranscriptLearningLog(file, () => false);
    await log.append('raw', 'corrected');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes only timestamp/raw/corrected and scrubs recognizable secrets', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'windvoice-transcript-'));
    dirs.push(dir);
    const file = path.join(dir, 'transcript-learning.jsonl');
    const log = new TranscriptLearningLog(file, () => true);
    await log.append(
      'use sk-proj-super-secret and api_key=abcdef123456',
      'use Codex with Bearer eyJ.secret.token'
    );

    const record = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['corrected', 'raw', 'timestamp']);
    expect(JSON.stringify(record)).not.toContain('super-secret');
    expect(JSON.stringify(record)).not.toContain('abcdef123456');
    expect(JSON.stringify(record)).not.toContain('eyJ.secret.token');
    expect(JSON.stringify(record)).toContain('***REDACTED***');
  });
});
