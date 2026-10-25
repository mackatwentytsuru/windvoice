/**
 * Typed failure for the local STT path. The orchestrator maps `code` to an
 * already-localized user notice (see `stt.engine === 'local'` handling in
 * dictation/orchestrator.ts) while `message` stays technical for the debug log.
 */
export type LocalSttErrorCode =
  // nothing is listening on the configured URL (and auto-start is off /
  // failed before the server came up)
  | 'unreachable'
  // the server accepted the connection but never answered in time
  | 'timeout'
  // the server answered with a non-2xx status or an unparsable body
  | 'server'
  // the configured URL is not http on a loopback host
  | 'invalid-url'
  // pythonPath / modelDir / serverScript missing or unusable
  | 'not-configured';

export class LocalSttError extends Error {
  readonly code: LocalSttErrorCode;

  constructor(code: LocalSttErrorCode, message: string) {
    super(message);
    this.name = 'LocalSttError';
    this.code = code;
  }
}
