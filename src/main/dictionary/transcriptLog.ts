import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { scrubSecrets } from '@main/debug';

const MAX_TRANSCRIPT_CHARS = 64 * 1024;

export interface TranscriptLogSink {
  append(raw: string, corrected: string): Promise<void>;
}

/**
 * Dedicated, opt-in learning log. It deliberately records no app/window,
 * account, API-key, error, or debug metadata — only the two transcript forms
 * needed to propose future dictionary pairs, after secret scrubbing.
 */
export class TranscriptLearningLog implements TranscriptLogSink {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly enabled: () => boolean
  ) {}

  append(raw: string, corrected: string): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    const record = {
      timestamp: new Date().toISOString(),
      raw: scrubSecrets(raw).slice(0, MAX_TRANSCRIPT_CHARS),
      corrected: scrubSecrets(corrected).slice(0, MAX_TRANSCRIPT_CHARS)
    };
    const operation = this.chain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    });
    this.chain = operation;
    return operation;
  }
}
