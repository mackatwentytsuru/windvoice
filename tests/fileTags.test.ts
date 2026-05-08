import { describe, expect, it } from 'vitest';
import { fileTagsProcessor } from '../src/main/postprocess/fileTags';

const ctx = { settings: {} as never };

describe('fileTagsProcessor', () => {
  it('rewrites English "file foo.ts" to @foo.ts', async () => {
    const out = await fileTagsProcessor.process('please open file main.ts now', ctx);
    expect(out).toContain('@main.ts');
    expect(out).not.toMatch(/file\s+main\.ts/);
  });

  it('rewrites Japanese "ファイル foo.ts"', async () => {
    const out = await fileTagsProcessor.process('ファイル main.ts を編集', ctx);
    expect(out).toContain('@main.ts');
  });

  it('rewrites Japanese "ファイルの foo.ts"', async () => {
    const out = await fileTagsProcessor.process('ファイルの index.tsx を見て', ctx);
    expect(out).toContain('@index.tsx');
  });

  it('handles paths with slashes', async () => {
    const out = await fileTagsProcessor.process('open file src/main/index.ts', ctx);
    expect(out).toContain('@src/main/index.ts');
  });

  it('leaves text unchanged when no file pattern is present', async () => {
    const text = 'hello world without any tags';
    const out = await fileTagsProcessor.process(text, ctx);
    expect(out).toBe(text);
  });

  it('handles multiple files in one transcript', async () => {
    const out = await fileTagsProcessor.process('file a.ts and file b.ts', ctx);
    expect(out).toContain('@a.ts');
    expect(out).toContain('@b.ts');
  });
});
