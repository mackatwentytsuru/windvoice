import fs from 'node:fs';
import { debug } from '@main/debug';

const PRIVATE_FILE_MODE = 0o600;

/** Tighten both newly-created and pre-existing electron-store files. */
export function enforcePrivateFileMode(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
    }
  } catch (err) {
    debug(
      'MAIN',
      `could not chmod store file to 0600: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
