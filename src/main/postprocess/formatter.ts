// GPT-based post-processing formatter. Cleans Whisper-style hallucinated
// repetitions, applies appropriate punctuation, enforces the user dictionary,
// and honors custom instructions and natural-language formatting commands.
//
// Failures (timeouts, API errors, missing key) are swallowed and the original
// transcript is returned, so this processor must never block the paste path.

import OpenAI from 'openai';
import { debug } from '@main/debug';
import type { PostProcessContext, PostProcessor } from '@main/postprocess/pipeline';
import type { DictionaryEntry, Settings } from '@shared/types';

const HARD_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL = 'gpt-5-mini';
const TEMPERATURE = 0.1;
const MIN_OUTPUT_TOKENS = 256;

/**
 * Reasoning / "o-series" / GPT-5 models reject the legacy `max_tokens` and
 * `temperature: <non-default>` parameters and require `max_completion_tokens`
 * with the default sampling temperature. Treat the gpt-5 family and the
 * o1/o3/o4 reasoning families as belonging to this group; everything else
 * (gpt-4, gpt-4o, gpt-3.5, etc.) still accepts the legacy params.
 */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
}

const clientCache = new Map<string, OpenAI>();

function getClient(apiKey: string): OpenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

export function buildSystemPrompt(settings: Readonly<Settings>): string {
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
      lines.push(`- "${entry.from}" -> "${entry.to}"`);
    }
  }

  const custom = settings.formatter?.customInstructions?.trim() ?? '';
  if (custom.length > 0) {
    lines.push('');
    lines.push('Additional user instructions (follow these unless they conflict with the strict rules above):');
    lines.push(custom);
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
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, params.text.length * 2);
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

export const gptFormatter: PostProcessor = {
  name: 'formatter',

  async process(text: string, ctx: PostProcessContext): Promise<string> {
    if (ctx.settings.formatter?.enabled === false) return text;
    if (!text || text.trim().length === 0) return text;

    const ctxKey = (ctx as PostProcessContext & { apiKey?: string }).apiKey;
    let apiKey: string | null = typeof ctxKey === 'string' && ctxKey.length > 0 ? ctxKey : null;
    if (!apiKey) {
      try {
        const mod = await import('@main/store/secure');
        apiKey = await mod.secureStore.getApiKey();
      } catch {
        apiKey = null;
      }
    }
    if (!apiKey || apiKey.length === 0) return text;

    const systemPrompt = buildSystemPrompt(ctx.settings);
    const model = ctx.settings.formatter?.model || DEFAULT_MODEL;

    try {
      const result = await withTimeout(
        (signal) =>
          callOpenAI({
            apiKey: apiKey as string,
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
      const msg = err instanceof Error ? err.message : String(err);
      debug('DICTATION', `formatter failed: ${msg}`);
      return text;
    }
  }
};
