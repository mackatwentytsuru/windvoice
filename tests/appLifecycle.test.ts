import { describe, expect, it, vi } from 'vitest';
import { registerResidentWindowLifecycle } from '@main/appLifecycle';

describe('resident app window lifecycle', () => {
  it('does not quit when every BrowserWindow is closed', () => {
    let onAllWindowsClosed: (() => void) | undefined;
    const app = {
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'window-all-closed') onAllWindowsClosed = listener;
      }),
      quit: vi.fn()
    };

    registerResidentWindowLifecycle(app);
    expect(onAllWindowsClosed).toBeTypeOf('function');

    onAllWindowsClosed?.();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
