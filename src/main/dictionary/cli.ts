import { DICTIONARY_TEXT_MAX, type DictionaryCorrection } from './schema';

const FLAG = '--add-correction';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class CorrectionCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionCliError';
  }
}

export function parseAddCorrectionArgs(argv: readonly string[]): DictionaryCorrection | null {
  const indexes = argv.flatMap((value, index) => (value === FLAG ? [index] : []));
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new CorrectionCliError(`${FLAG} may only be specified once`);

  const raw = argv[indexes[0]! + 1];
  if (raw === undefined) throw new CorrectionCliError(`${FLAG} requires 誤変換=正しい語`);
  const separator = raw.indexOf('=');
  if (separator < 0) throw new CorrectionCliError(`${FLAG} requires an '=' separator`);

  const variant = raw.slice(0, separator).trim();
  const correct = raw.slice(separator + 1).trim();
  validatePart('誤変換', variant);
  validatePart('正しい語', correct);
  if (variant === correct) throw new CorrectionCliError('誤変換 and 正しい語 must differ');
  return { variant, correct };
}

function validatePart(label: string, value: string): void {
  if (!value) throw new CorrectionCliError(`${label} must not be empty`);
  if (value.length > DICTIONARY_TEXT_MAX) {
    throw new CorrectionCliError(`${label} must be at most ${DICTIONARY_TEXT_MAX} characters`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new CorrectionCliError(`${label} must not contain control characters`);
  }
}
