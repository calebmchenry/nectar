export class ExecutionContext {
  private readonly values = new Map<string, string>();
  private readonly run_log: string[] = [];

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

  clone(): ExecutionContext {
    const cloned = new ExecutionContext(this.snapshot());
    // Preserve run_log through serialization: stored in _run_log key
    for (const entry of this.run_log) {
      cloned.appendLog(entry);
    }
    return cloned;
  }

  snapshot(): Record<string, string> {
    const snap = Object.fromEntries(this.values.entries());
    // Serialize run_log into snapshot as reserved key
    if (this.run_log.length > 0) {
      snap['_run_log'] = JSON.stringify(this.run_log);
    }
    return snap;
  }

  restore(snapshot: Record<string, string>): void {
    this.values.clear();
    this.run_log.length = 0;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === '_run_log') {
        try {
          const entries = JSON.parse(value) as string[];
          for (const entry of entries) {
            this.run_log.push(entry);
          }
        } catch {
          // ignore malformed log
        }
        continue;
      }
      this.values.set(key, value);
    }
  }

  appendLog(entry: string): void {
    this.run_log.push(entry);
  }

  getLog(): readonly string[] {
    return this.run_log;
  }
}
