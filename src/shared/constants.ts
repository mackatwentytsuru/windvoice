// Shared timing/sizing constants used in both main and renderer.

/** Audio capture chunk size, in milliseconds. */
export const CHUNK_MS = 50;

/** Target PCM sample rate (Hz) for the OpenAI Realtime API. */
export const TARGET_SAMPLE_RATE = 24_000;

/** Minimum buffered audio (ms) before we accept a `commit` request. */
export const MIN_AUDIO_MS = 200;

/**
 * The OpenAI Realtime API rejects `input_audio_buffer.commit` when the
 * server-side buffer holds less than 100 ms of audio ("buffer too small.
 * Expected at least 100ms of audio, but buffer only has 0.00ms of audio").
 * The RealtimeClient counts the PCM bytes it actually pushes over the wire
 * and refuses to commit below this floor, so that server error can never
 * reach the user — a short or dropped take is abandoned client-side with a
 * friendly notice instead.
 */
export const MIN_COMMIT_AUDIO_MS = 100;

/** PCM16 = 2 bytes per sample, mono. Used to size the commit floor in bytes. */
export const BYTES_PER_SAMPLE = 2;

/**
 * RMS energy below which a chunk is treated as digital silence. A quiet
 * room's noise floor sits well above this; a dead/"live-but-silent" mic
 * pipeline delivers exact zeros. Shared by the renderer-side capture
 * watchdog (audio/bridge.ts) and the dictation orchestrator so both judge
 * "no real audio" by the same bar.
 */
export const SILENCE_RMS_THRESHOLD = 0.001;

/** Hard timeout (ms) on awaiting a final transcript after `commit`. */
export const FINAL_TIMEOUT_MS = 8_000;

/** Maximum stored history entries. */
export const MAX_HISTORY = 200;
