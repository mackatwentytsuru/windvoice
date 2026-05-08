// File-tag rewriter (AquaVoice-inspired). When the user says variants of
// "ファイル <name>" or "file <name>" mid-dictation, replace the surface form
// with `@<name>` so editors like Cursor/Windsurf can autocomplete it.
//
// Heuristic-only: the formatter step (when enabled) covers more nuanced
// cases. This processor is cheap and runs locally, so it's useful even
// when the GPT formatter is off or fails.

import type { PostProcessor } from './pipeline';

const PATTERNS: ReadonlyArray<{ pattern: RegExp; replace: (match: string, name: string) => string }> = [
  // English: "file foo.ts" or "file foo dot ts"
  {
    pattern: /\bfile\s+([A-Za-z0-9_./-]+)\b/gi,
    replace: (_m, name: string) => `@${name}`
  },
  // Japanese: 「ファイル foo.ts」 / 「ファイルの foo.ts」 / 「ファイル foo」
  {
    pattern: /ファイル(?:の)?\s*([A-Za-z0-9_./-]+)/g,
    replace: (_m, name: string) => `@${name}`
  }
];

export const fileTagsProcessor: PostProcessor = {
  name: 'fileTags',

  async process(text: string): Promise<string> {
    if (!text) return text;
    let out = text;
    for (const { pattern, replace } of PATTERNS) {
      out = out.replace(pattern, replace);
    }
    return out;
  }
};
