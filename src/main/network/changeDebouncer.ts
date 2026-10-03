export class NetworkChangeDebouncer {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly debounceMs = 4_000
  ) {}

  notify(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  dispose(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
