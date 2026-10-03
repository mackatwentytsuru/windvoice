// Formatter fast path.
//
// The LLM formatter is ~65% of key-up → paste latency (median ~1.4 s in field
// logs) and is called even for a one-word reply. Short or already-punctuated
// takes rarely change, so when nothing in the take needs the model —
// no formatting commands, no stutter/hallucination pattern, no fillers, no
// user/app instructions that could reshape it — finish it locally instead.
// The same idea ships in VoiceInk (SkipShortEnhancement) and Handy (raw
// default hotkey). Every check errs toward calling the model.

import type { Settings } from '@shared/types';

export const FAST_PATH_SHORT_CHARS = 20;
export const FAST_PATH_PUNCTUATED_CHARS = 60;

const COMMAND_RE = /改行|箇条書き|コードブロック|new paragraph|bullet points?|code block/i;
// A 1-6 char unit repeated 3+ times in a row ("結結結", "こんにちはこんにちはこんにちは").
const REPEAT_RE = /(.{1,6}?)\1{2,}/su;
// Spoken fillers the model would remove. Japanese fillers attach directly to
// the next word ("あのー明日"), so the long-vowel forms match anywhere; the
// ambiguous bare "あの" ("あの人") only counts when followed by a pause.
const FILLER_RE =
  /えー+と?|えっと|ええと|あのー+|うーん|んー+|(?:^|[\s、。])あの[、\s]|(?:^|\s)(?:um+|uh+|erm)\b/iu;
const SENTENCE_END_RE = /[。．！？!?.…」』）)]$/u;
const JA_CHAR_RE = /[぀-ヿ㐀-鿿]$/u;

export interface FastPathInput {
  text: string;
  settings: Readonly<Settings>;
  /** True when an app profile with non-empty instructions matches. */
  hasAppInstructions: boolean;
}

/** Returns the locally finished text, or null when the model is needed. */
export function tryFastPath({ text, settings, hasAppInstructions }: FastPathInput): string | null {
  if (settings.formatter?.fastPath === false) return null;
  if ((settings.formatter?.customInstructions ?? '').trim().length > 0) return null;
  if (hasAppInstructions) return null;

  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (COMMAND_RE.test(trimmed) || REPEAT_RE.test(trimmed) || FILLER_RE.test(trimmed)) {
    return null;
  }
  if (trimmed.includes('\n')) return null;

  const short = [...trimmed].length <= FAST_PATH_SHORT_CHARS;
  const punctuated =
    [...trimmed].length <= FAST_PATH_PUNCTUATED_CHARS && SENTENCE_END_RE.test(trimmed);
  if (!short && !punctuated) return null;

  let out = applyStrictDictionary(trimmed, settings);
  const lang = (settings.language || 'ja').toLowerCase();
  if (lang.startsWith('ja')) {
    if (JA_CHAR_RE.test(out)) out += '。';
  } else if (lang.startsWith('en')) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
    if (/[A-Za-z0-9]$/.test(out)) out += '.';
  }
  return out;
}

/** The formatter prompt treats settings.dictionary as strict replacements;
 * apply them the same way when the model is skipped. */
function applyStrictDictionary(text: string, settings: Readonly<Settings>): string {
  let out = text;
  for (const entry of settings.dictionary ?? []) {
    if (!entry || typeof entry.from !== 'string' || entry.from.length === 0) continue;
    out = out.split(entry.from).join(entry.to ?? '');
  }
  return out;
}
