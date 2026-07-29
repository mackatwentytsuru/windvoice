import { describe, expect, it } from 'vitest';
import { generalSettingsVisibility } from '@renderer/platformCapabilities';

describe('General platform-specific setting visibility', () => {
  it('shows Type and clipboard-history exclusion only on Windows', () => {
    expect(generalSettingsVisibility('win32')).toEqual({
      typeInsertion: true,
      clipboardHistoryExclusion: true
    });
  });

  it.each(['linux', 'darwin', 'freebsd'])(
    'hides ineffective insertion settings on %s',
    (platform) => {
      expect(generalSettingsVisibility(platform)).toEqual({
        typeInsertion: false,
        clipboardHistoryExclusion: false
      });
    }
  );
});
