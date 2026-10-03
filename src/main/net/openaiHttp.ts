// HTTP plumbing for OpenAI REST calls (the formatter).
//
// The OpenAI SDK defaults to Node's global fetch, whose undici pool closes an
// idle keep-alive socket after 4 s. Dictation takes are usually longer than
// that, so nearly every formatter call paid a fresh TCP + TLS handshake
// (~50-200 ms) on the critical path between transcript and paste. Electron's
// net.fetch runs on Chromium's network stack instead: HTTP/2, a shared
// connection pool with minutes-long idle reuse, and system proxy support.
// preconnectOpenAI() opens that connection at key-down, while the user is
// still speaking.

import { net, session } from 'electron';

const OPENAI_ORIGIN = 'https://api.openai.com';

export const openaiFetch = ((input: string | URL | Request, init?: RequestInit) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)) as typeof fetch;

export function preconnectOpenAI(): void {
  try {
    session.defaultSession?.preconnect({ url: OPENAI_ORIGIN, numSockets: 1 });
  } catch {
    // Best-effort warm-up; the request itself still connects on demand.
  }
}
