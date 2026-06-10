/**
 * Shared delay helper for main-process code. Replaces the four identical
 * local `sleep()` definitions that had drifted across orchestrator.ts,
 * typer.ts, streamingTyper.ts and typeText.ts.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
