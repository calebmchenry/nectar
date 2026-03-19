export class ExecutionContext {
  private readonly values = new Map<string, string>();

  constructor(seed?: Record<string, string>) {
    if (!seed) {
      return;
    }
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key, value);
    }
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  setMany(updates: Record<string, string>): void {
    for (const [key, value] of Object.entries(updates)) {
      this.values.set(key, value);
    }
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values.entries());
  }

  restore(snapshot: Record<string, string>): void {
    this.values.clear();
    for (const [key, value] of Object.entries(snapshot)) {
      this.values.set(key, value);
    }
  }
}
