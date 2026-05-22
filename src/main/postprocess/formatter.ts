// GPT-based post-processing formatter. Cleans Whisper-style hallucinated
// repetitions, applies appropriate punctuation, enforces the user dictionary,
// and honors custom instructions and natural-language formatting commands.
//
// Failures (timeouts, API errors, missing key) are swallowed and the original
// transcript is returned, so this processor must never block the paste path.

import crypto from 'node:crypto';
import OpenAI from 'openai';
import { debug } from '@main/debug';
import type { PostProcessContext, PostProcessor } from '@main/postprocess/pipeline';
import type { DictionaryEntry, Settings } from '@shared/types';

const HARD_TIMEOUT_MS = 2_000;
const DEFAULT_MODEL = 'gpt-5-mini';
const TEMPERATURE = 0.1;
const MIN_OUTPUT_TOKENS = 256;

/**
 * After a hard-failure response (401 invalid key, model not found, etc.)
 * skip subsequent formatter calls until the user re-enters their API key
 * (`resetFormatterFailure()` is called from the APIKEY_SET handler). This
 * prevents the post-401 case from silently sending every dictation as
 * unformatted Whisper output forever — the user sees an error event
 * surface in the settings UI and knows to update their key.
 */
let permanentFailureReason: string | null = null;
let permanentFailureCode: string | null = null;

export function resetFormatterFailure(): void {
  permanentFailureReason = null;
  permanentFailureCode = null;
  // Purge cached OpenAI clients so a rotated API key actually takes
  // effect. Each cached client retains its constructor `apiKey` string
  // internally; without this clear, a 401 → key-rotation flow would
  // keep using the stale client and the new key would never reach the
  // heap on subsequent calls.
  clientCache.clear();
}

export function getFormatterFailure(): { code: string; message: string } | null {
  if (!permanentFailureReason || !permanentFailureCode) return null;
  return { code: permanentFailureCode, message: permanentFailureReason };
}

/** Surface formatter failure to the broader app. Wired up from main/index.ts
 * to flash the tray and emit an IPC event. */
let onPermanentFailure: ((code: string, message: string) => void) | null = null;
export function setFormatterFailureListener(
  cb: ((code: string, message: string) => void) | null
): void {
  onPermanentFailure = cb;
}

/**
 * Reasoning / "o-series" / GPT-5 models reject the legacy `max_tokens` and
 * `temperature: <non-default>` parameters and require `max_completion_tokens`
 * with the default sampling temperature. Treat the gpt-5 family and the
 * o1/o3/o4 reasoning families as belonging to this group; everything else
 * (gpt-4, gpt-4o, gpt-3.5, etc.) still accepts the legacy params.
 *
 * The regex matches the exact family head followed by either end-of-string
 * or `-` so `o1`/`o1-mini` match but a hypothetical `o123`/`o4code-mini`
 * (which would be NEITHER an o-series nor a reasoning model) does not.
 * Exported so unit tests can pin the classification table.
 */
const REASONING_MODEL_RE = /^(?:gpt-5|o[134])(?:-|$)/;

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model.toLowerCase());
}

// Cache OpenAI clients by a hash of the API key, never the raw key.
// Keeping the raw key as a Map key would leave it in V8's heap
// indefinitely (Map keys are strongly retained for the life of the
// module), where heap dumps / crash reports could expose it. The hash
// is unique per key so cache lookup is still O(1).
//
// MEDIUM-1: bound the cache with a small FIFO cap. The realistic usage
// is one (current) + at most one stale key after a rotation; without a
// cap, an unattended long-running process that rotated keys repeatedly
// would accumulate one client + buffered HTTP keepalive sockets per
// rotation. Map iteration order is insertion order in JS, so the oldest
// entry is `keys().next().value`.
const CLIENT_CACHE_MAX = 4;
const clientCache = new Map<string, OpenAI>();

function hashKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function getClient(apiKey: string): OpenAI {
  const k = hashKey(apiKey);
  let client = clientCache.get(k);
  if (!client) {
    if (clientCache.size >= CLIENT_CACHE_MAX) {
      const oldest = clientCache.keys().next().value;
      if (typeof oldest === 'string') clientCache.delete(oldest);
    }
    client = new OpenAI({ apiKey });
    clientCache.set(k, client);
  }
  return client;
}

/**
 * Escape values interpolated into the system prompt so a malicious or
 * accidentally-pasted dictionary entry / custom-instruction value cannot
 * break out of the surrounding bullet-list + double-quoted-string context
 * and inject new directives (issue #31). We do not truncate length — just
 * neutralize the characters that could terminate a line or a quoted span.
 *
 * Exported so any other code path that interpolates external/system-derived
 * strings (e.g. active-window titles, OS-derived process names) into LLM
 * prompts can apply the same escape rules — see issue #35.
 */
export function sanitizePromptValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Find the first per-app formatter profile whose `match` is a
 * case-insensitive substring of the foreground app name. Matching is
 * done against the app name only (never the window title — titles can
 * carry PII; see context/activeWindow.ts).
 */
function matchAppProfile(
  settings: Readonly<Settings>,
  appName: string | undefined
): { match: string; instructions: string } | null {
  const profiles = settings.formatter?.appProfiles;
  if (!profiles || profiles.length === 0) return null;
  const app = (appName ?? '').toLowerCase();
  if (!app) return null;
  for (const p of profiles) {
    const m = p.match.trim().toLowerCase();
    if (m && app.includes(m)) return p;
  }
  return null;
}

export function buildSystemPrompt(
  settings: Readonly<Settings>,
  activeWindowApp?: string
): string {
  const language = settings.language || 'ja';
  const isJa = language.toLowerCase().startsWith('ja');

  const lines: string[] = [];
  lines.push('You are a post-processing formatter for a real-time speech-to-text dictation app.');
  lines.push('Your job is to clean up the transcript and return ONLY the corrected text.');
  lines.push('');
  lines.push('Strict rules:');
  lines.push('- Output the formatted text only. No explanations, no quotes, no preamble.');
  lines.push('- Never summarize, paraphrase, translate, or add information not in the input.');
  lines.push('- If the input is already clean, return it unchanged.');
  lines.push(
    '- Remove Whisper-style hallucinated repetitions (e.g. "結結結こんにちはこんにちは" -> "こんにちは"). Detect repeated leading characters and trailing duplicated phrases and collapse them.'
  );
  lines.push(
    `- Add appropriate ${isJa ? 'Japanese (。、「」など)' : 'English'} punctuation, spacing, and capitalization where missing.`
  );
  lines.push(`- Target language: ${language}.`);
  lines.push('');
  lines.push('Natural-language formatting commands inside the speech:');
  lines.push('- "改行" or "new paragraph" -> insert a paragraph break and remove the command word.');
  lines.push('- "箇条書き" or "bullet points" -> format the following items as a bulleted list and remove the command.');
  lines.push('- "コードブロック" or "code block" -> wrap the content in a fenced code block and remove the command.');

  const dictionary = (settings.dictionary ?? []).filter(
    (entry): entry is DictionaryEntry => !!entry && typeof entry.from === 'string' && entry.from.length > 0
  );
  if (dictionary.length > 0) {
    lines.push('');
    lines.push('User dictionary (apply these as STRICT replacements; the left side must be replaced with the right side wherever it appears):');
    for (const entry of dictionary) {
      lines.push(`- "${sanitizePromptValue(entry.from)}" -> "${sanitizePromptValue(entry.to)}"`);
    }
  }

  const custom = settings.formatter?.customInstructions?.trim() ?? '';
  if (custom.length > 0) {
    lines.push('');
    lines.push('Additional user instructions (follow these unless they conflict with the strict rules above):');
    lines.push(sanitizePromptValue(custom));
  }

  const profile = matchAppProfile(settings, activeWindowApp);
  const profileInstructions = profile?.instructions.trim() ?? '';
  if (profileInstructions.length > 0) {
    lines.push('');
    lines.push(
      'App-specific instructions for the application the user is currently dictating into (follow these unless they conflict with the strict rules above):'
    );
    lines.push(sanitizePromptValue(profileInstructions));
  }

  return lines.join('\n');
}

interface FormatterCallParams {
  apiKey: string;
  model: string;
  systemPrompt: string;
  text: string;
  signal: AbortSignal;
}

async function callOpenAI(params: FormatterCallParams): Promise<string> {
  const client = getClient(params.apiKey);
  // LOW-6: the non-reasoning branch previously used `text.length * 2`,
  // which can fall below the punctuated/expanded output budget when the
  // input is short (e.g. a single katakana word that the formatter
  // expands with a sentence-final 。). Add a Math.ceil(len * 1.5) + 128
  // safety pad on top of the MIN_OUTPUT_TOKENS floor so the cap can
  // never be smaller than the worst plausible expansion.
  const maxTokens = Math.max(
    MIN_OUTPUT_TOKENS,
    params.text.length * 2,
    Math.ceil(params.text.length * 1.5) + 128
  );
  const reasoning = isReasoningModel(params.model);

  const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: params.model,
    stream: false,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.text }
    ],
    ...(reasoning
      ? {
          // GPT-5 / reasoning models consume tokens for an internal reasoning
          // pass before emitting visible output. For a deterministic
          // formatting task this reasoning is wasted budget — and at the
          // default effort level the model often spends the entire
          // max_completion_tokens cap on reasoning and returns an empty
          // completion. `reasoning_effort: 'minimal'` skips that phase.
          // We also generously over-budget completion tokens so even very
          // long transcripts (with the reasoning floor on top) fit.
          max_completion_tokens: Math.max(maxTokens, 1024) + 512,
          reasoning_effort: 'minimal'
        }
      : { temperature: TEMPERATURE, max_tokens: maxTokens })
  };

  const response = await client.chat.completions.create(request, { signal: params.signal });

  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') return '';
  return content;
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`formatter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

interface OpenAIErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

function classifyFormatterError(err: unknown): {
  code: 'E_AUTH' | 'E_RATE_LIMIT' | 'E_NOT_FOUND' | 'E_TIMEOUT' | 'E_NETWORK' | 'E_UNKNOWN';
  permanent: boolean;
  message: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) {
    return { code: 'E_TIMEOUT', permanent: false, message: msg };
  }
  const oe = err as OpenAIErrorLike | undefined;
  const status = typeof oe?.status === 'number' ? oe.status : 0;
  // 401: bad / expired key → permanent until user updates the key.
  // 404: model not found (e.g. typo or deprecated) → permanent until
  //      user changes model selection.
  if (status === 401 || /\bunauthorized\b|invalid_api_key/i.test(msg)) {
    return { code: 'E_AUTH', permanent: true, message: msg };
  }
  if (status === 404 || /model.*not.*found|does not exist/i.test(msg)) {
    return { code: 'E_NOT_FOUND', permanent: true, message: msg };
  }
  if (status === 429) {
    return { code: 'E_RATE_LIMIT', permanent: false, message: msg };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(msg)) {
    return { code: 'E_NETWORK', permanent: false, message: msg };
  }
  return { code: 'E_UNKNOWN', permanent: false, message: msg };
}

export const gptFormatter: PostProcessor = {
  name: 'formatter',

  async process(text: string, ctx: PostProcessContext): Promise<string> {
    if (ctx.settings.formatter?.enabled === false) return text;
    if (!text || text.trim().length === 0) return text;
    // After a known-permanent failure (bad key, missing model) the next
    // formatter call would hit the same wall. Skip until the user
    // explicitly updates the API key (which calls resetFormatterFailure).
    if (permanentFailureReason !== null) return text;

    const ctxKey = (ctx as PostProcessContext & { apiKey?: string }).apiKey;
    const ctxApiKey: string | null =
      typeof ctxKey === 'string' && ctxKey.length > 0 ? ctxKey : null;
    let apiKey: string | null = ctxApiKey;
    if (!apiKey) {
      try {
        const mod = await import('@main/store/secure');
        apiKey = await mod.secureStore.getApiKey();
      } catch {
        apiKey = null;
      }
    }
    if (!apiKey || apiKey.length === 0) return text;

    // Capture into a const so TypeScript can narrow inside the async
    // callback below without an `as string` cast.
    const key = apiKey;
    const systemPrompt = buildSystemPrompt(ctx.settings, ctx.activeWindowApp);
    const model = ctx.settings.formatter?.model || DEFAULT_MODEL;

    try {
      const result = await withTimeout(
        (signal) =>
          callOpenAI({
            apiKey: key,
            model,
            systemPrompt,
            text,
            signal
          }),
        HARD_TIMEOUT_MS
      );
      const trimmed = result.trim();
      if (trimmed.length === 0) {
        debug('DICTATION', 'formatter: empty completion, falling back to original text');
        return text;
      }
      return trimmed;
    } catch (err) {
      const classified = classifyFormatterError(err);
      debug('DICTATION', `formatter failed [${classified.code}]: ${classified.message}`);
      if (classified.permanent) {
        permanentFailureReason = classified.message;
        permanentFailureCode = classified.code;
        onPermanentFailure?.(classified.code, classified.message);
      }
      return text;
    }
  }
};
