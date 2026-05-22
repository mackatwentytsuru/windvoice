// Shared API-key validation.
//
// Used by both the IPC handler's Zod schema and the keytar-backed
// `SecureStore.setApiKey` checks so the two paths cannot drift out of
// sync. The constants here are the SINGLE source of truth — see
// `ApiKeySchema` in `src/main/ipc/handlers.ts` and the explicit length
// check in `src/main/store/secure.ts`.

/** Minimum length of a valid-looking OpenAI API key. */
export const API_KEY_MIN_LENGTH = 10;
/** Maximum length we will accept. Real OpenAI keys are well under this. */
export const API_KEY_MAX_LENGTH = 512;

/**
 * Returns true when the trimmed value passes our cheap length-based
 * sanity check. We never inspect prefix / character set here — OpenAI
 * has rotated their key prefix (`sk-...` → `sk-proj-...` → other) more
 * than once and pinning to a regex would lock out future key formats.
 */
export function isValidApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= API_KEY_MIN_LENGTH && trimmed.length <= API_KEY_MAX_LENGTH;
}
