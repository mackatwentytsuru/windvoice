// Post-processing pipeline. Each registered processor receives the raw
// transcript (post-Realtime, pre-paste) and returns a modified version.
// Processors run in registration order; an empty/throw skips that step.

import { debug } from '@main/debug';
import type { Settings } from '@shared/types';

export interface PostProcessContext {
  settings: Settings;
  /** Active window title, if known (Phase 3 enhancement). */
  activeWindowTitle?: string;
  /** OpenAI API key, only passed to processors that need it. */
  apiKey?: string;
}

export interface PostProcessor {
  /** Identifier for logs and selective skip; e.g. "formatter", "replacements". */
  name: string;
  /**
   * Returning the input string is a valid no-op. Throwing is logged and
   * the original (pre-throw) text is forwarded to the next processor.
   */
  process(text: string, ctx: PostProcessContext): Promise<string>;
}

class PostProcessorPipeline {
  private processors: PostProcessor[] = [];

  register(processor: PostProcessor): void {
    if (this.processors.some((p) => p.name === processor.name)) return;
    this.processors.push(processor);
  }

  unregister(name: string): void {
    this.processors = this.processors.filter((p) => p.name !== name);
  }

  list(): readonly PostProcessor[] {
    return this.processors;
  }

  async run(input: string, ctx: PostProcessContext): Promise<string> {
    let current = input;
    for (const p of this.processors) {
      try {
        const next = await p.process(current, ctx);
        if (typeof next === 'string') current = next;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug('DICTATION', `processor "${p.name}" threw: ${msg}`);
      }
    }
    return current;
  }
}

export const postProcessorPipeline = new PostProcessorPipeline();
