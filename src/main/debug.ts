// One env var to rule them all. Setting `WINDVOICE_DEBUG=1` enables every
// domain; alternatively domain-specific vars (e.g. `WINDVOICE_DEBUG_AUDIO`)
// are still honored for finer-grained control.

const ALL = process.env['WINDVOICE_DEBUG'] === '1';

const DOMAINS = ['HOTKEY', 'AUDIO', 'REALTIME', 'DICTATION', 'DUCK', 'OVERLAY'] as const;
type Domain = (typeof DOMAINS)[number];

function enabledFor(domain: Domain): boolean {
  if (ALL) return true;
  return process.env[`WINDVOICE_DEBUG_${domain}`] === '1';
}

export function debug(domain: Domain, message: string): void {
  if (!enabledFor(domain)) return;
  process.stderr.write(`[${domain.toLowerCase()}] ${message}\n`);
}

export function isDebug(domain: Domain): boolean {
  return enabledFor(domain);
}
