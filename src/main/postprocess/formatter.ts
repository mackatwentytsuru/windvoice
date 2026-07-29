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
import { APP_PROFILE_INSTRUCTIONS_MAX, type DictionaryEntry, type Settings } from '@shared/types';

// gpt-5-mini formatting a short transcript routinely takes 2-4s; the old 2000ms
// ceiling timed out on essentially every call (15 consecutive E_TIMEOUTs in the
// field log), so formatting never actually applied. A flat 5000ms fixed the
// short case but still timed out on long dictations (17 E_TIMEOUTs in the
// field log — completion time grows with transcript length). The ceiling now
// scales with input size, bounded so insertion never waits absurdly long
// before falling back to the raw transcript on a genuinely stuck call.
const BASE_TIMEOUT_MS = 5_000;
const PER_CHAR_TIMEOUT_MS = 25;
const MAX_TIMEOUT_MS = 12_000;

/** Adaptive formatter deadline: 5s floor + 25ms per input char, 12s cap.
 * Exported for tests. */
export function formatterTimeoutMs(textLength: number): number {
  return Math.min(BASE_TIMEOUT_MS + textLength * PER_CHAR_TIMEOUT_MS, MAX_TIMEOUT_MS);
}
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
 * Escape values interpolated into the system prompt so an attacker-controlled
 * string (active-window title, OS-derived process name, third-party-derived
 * dictionary entry) cannot break out of the surrounding bullet-list +
 * double-quoted-string context and inject new directives (issue #31). We do
 * not truncate length — just neutralize the characters that could terminate
 * a line or a quoted span.
 *
 * MEDIUM-2 — trust boundary: this helper is for UNTRUSTED inputs only.
 * `customInstructions` and `appProfiles[].instructions` are typed by the
 * USER into their own Settings window; they are deliberately allowed to
 * include multi-line text, bullet lists, and quoted examples. Treating
 * them as untrusted would force the user to escape their own newlines.
 * Anything coming from outside the Settings window (active-window titles,
 * dictionary entries that might be shared via export/import) MUST still
 * pass through this helper before reaching the prompt.
 */
export function sanitizePromptValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Normalize an app/profile name for matching: lowercase, trimmed, with a
 * trailing `.exe` stripped. Windows reports process names like
 * `Code.exe` / `msedge.exe` while users naturally type `code` or
 * `msedge` (and vice versa) — strip the extension on BOTH sides so the
 * two spellings are interchangeable.
 */
function normalizeAppName(v: string): string {
  return v.trim().toLowerCase().replace(/\.exe$/, '');
}

/** Escape regex metacharacters so a user-typed profile `match` is always
 * treated as a literal string inside the word-boundary regex below. */
function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the first per-app formatter profile that matches the foreground
 * app name. Matching is done against the app name only (never the window
 * title — titles can carry PII; see context/activeWindow.ts).
 *
 * Hardening: a bare `includes()` substring test over-matched — profile
 * "code" matched "decode.exe" — and let any app whose name merely embeds
 * a profile token inherit that profile's instructions. Both sides are
 * now normalized (see `normalizeAppName`) and the profile `match` must
 * appear at WORD BOUNDARIES inside the app name, i.e. not glued to an
 * adjacent letter or digit. This is the least surprising tightening for
 * existing configs: "Terminal" still matches "Windows Terminal", "code"
 * still matches "Visual Studio Code" and "Code.exe", but "code" no
 * longer matches "decode". The boundary classes use Unicode property
 * escapes so the same rule holds for non-ASCII app names (e.g. "メモ帳").
 */
function matchAppProfile(
  settings: Readonly<Settings>,
  appName: string | undefined
): { match: string; instructions: string } | null {
  const profiles = settings.formatter?.appProfiles;
  if (!profiles || profiles.length === 0) return null;
  const app = normalizeAppName(appName ?? '');
  if (!app) return null;
  for (const p of profiles) {
    const m = normalizeAppName(p.match);
    if (!m) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(m)}(?![\\p{L}\\p{N}])`, 'u');
    if (re.test(app)) return p;
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

  // MEDIUM-2: customInstructions and appProfiles[].instructions are
  // user-typed within the Settings window — inside the trust boundary —
  // so they are passed through to the LLM verbatim. The user is allowed
  // to embed newlines, bullets, and quoted examples in their own
  // formatter instructions; sanitizing those would force them to escape
  // their own input. Anything originating outside the Settings UI
  // (window titles, third-party-imported dictionary entries) must still
  // go through `sanitizePromptValue` before reaching the prompt.
  const custom = settings.formatter?.customInstructions?.trim() ?? '';
  if (custom.length > 0) {
    lines.push('');
    lines.push('Additional user instructions (follow these unless they conflict with the strict rules above):');
    lines.push(custom);
  }

  const profile = matchAppProfile(settings, activeWindowApp);
  // Cap profile instructions at use even though the settings schema also
  // clamps them (defense in depth): instructions flow verbatim into the
  // LLM system prompt, so a settings file written outside the schema path
  // (hand-edited JSON, an older app version, a third-party config import)
  // must not be able to smuggle an unbounded prompt-injection payload.
  const profileInstructions = (profile?.instructions ?? '')
    .slice(0, APP_PROFILE_INSTRUCTIONS_MAX)
    .trim();
  if (profileInstructions.length > 0) {
    lines.push('');
    lines.push(
      'App-specific instructions for the application the user is currently dictating into (follow these unless they conflict with the strict rules above):'
    );
    lines.push(profileInstructions);
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
          //
          // NOTE: `reasoning_effort` IS the correct top-level parameter for
          // the Chat Completions API used here (`client.chat.completions
          // .create`); the nested `reasoning: { effort }` shape belongs to
          // the Responses API only. Do not "fix" this.
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

    // The API key is always loaded from the OS keychain via secureStore.
    // PostProcessContext deliberately carries no key material (so context
    // objects can flow through logging / pipeline code without secrets).
    // An earlier revision read a phantom `ctx.apiKey` here via an unsafe
    // cast — the field never existed on the context type, so that branch
    // was dead code and implied a second key source that never existed.
    let apiKey: string | null = null;
    try {
      const mod = await import('@main/store/secure');
      apiKey = await mod.secureStore.getApiKey();
    } catch {
      apiKey = null;
    }
    if (!apiKey || apiKey.length === 0) return text;

    // Capture into a const so TypeScript can narrow inside the async
    // callback below without an `as string` cast.
    const key = apiKey;
    const systemPrompt = buildSystemPrompt(ctx.settings, ctx.activeWindowApp);
    const model = ctx.settings.formatter?.model || DEFAULT_MODEL;

    const startedAt = Date.now();
    const timeoutMs = formatterTimeoutMs(text.length);
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
        timeoutMs
      );
      // Duration is logged on success so the adaptive timeout can be tuned
      // from field logs instead of guessed.
      debug(
        'DICTATION',
        `formatter ok in ${Date.now() - startedAt}ms (len=${text.length} timeout=${timeoutMs}ms)`
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
