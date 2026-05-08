// Shared timing/sizing constants used in both main and renderer.

/** Audio capture chunk size, in milliseconds. */
export const CHUNK_MS = 50;

/** Target PCM sample rate (Hz) for the OpenAI Realtime API. */
export const TARGET_SAMPLE_RATE = 24_000;

/** Minimum buffered audio (ms) before we accept a `commit` request. */
export const MIN_AUDIO_MS = 200;

/** Hard timeout (ms) on awaiting a final transcript after `commit`. */
export const FINAL_TIMEOUT_MS = 8_000;

/** Maximum stored history entries. */
export const MAX_HISTORY = 200;
