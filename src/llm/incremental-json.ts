export class IncrementalJsonParser<T extends Record<string, unknown>> {
  private buffer = '';
  private scanIndex = 0;
  private rootStart = -1;
  private rootEnded = -1;
  private depth = 0;
  private inString = false;
  private escapeNext = false;
  private lastEmittedEnd = -1;

  feed(chunk: string): Partial<T>[] {
    this.buffer += chunk;
    const partials: Partial<T>[] = [];

    for (let i = this.scanIndex; i < this.buffer.length; i++) {
      const ch = this.buffer[i]!;

      if (this.rootStart === -1) {
        if (/\s/.test(ch)) {
          continue;
        }
        if (ch !== '{') {
          throw new Error(`Expected JSON object start, found '${ch}'.`);
        }
        this.rootStart = i;
        this.depth = 1;
        continue;
      }

      if (this.rootEnded !== -1) {
        if (!/\s/.test(ch)) {
          throw new Error('Unexpected non-whitespace data after JSON object end.');
        }
        continue;
      }

      if (this.inString) {
        if (this.escapeNext) {
          this.escapeNext = false;
          continue;
        }
        if (ch === '\\') {
          this.escapeNext = true;
          continue;
        }
        if (ch === '"') {
          this.inString = false;
        }
        continue;
      }

      if (ch === '"') {
        this.inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        this.depth += 1;
        continue;
      }

      if (ch === '}' || ch === ']') {
        if (this.depth <= 0) {
          throw new Error('JSON parser depth underflow.');
        }

        const closesRootObject = ch === '}' && this.depth === 1;
        this.depth -= 1;

        if (closesRootObject) {
          this.rootEnded = i;
          const partial = this.parseSnapshot(i + 1, true);
          if (partial) {
            partials.push(partial);
          }
        }
        continue;
      }

      if (ch === ',' && this.depth === 1) {
        const partial = this.parseSnapshot(i, false);
        if (partial) {
          partials.push(partial);
        }
      }
    }

    this.scanIndex = this.buffer.length;
    return partials;
  }

  get text(): string {
    return this.buffer;
  }

  private parseSnapshot(endIndex: number, isFinal: boolean): Partial<T> | null {
    if (this.rootStart === -1 || endIndex <= this.rootStart + 1) {
      return null;
    }
    if (endIndex === this.lastEmittedEnd) {
      return null;
    }

    const source = isFinal
      ? this.buffer.slice(this.rootStart, endIndex)
      : `${this.buffer.slice(this.rootStart, endIndex)}}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse incremental JSON snapshot: ${message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Incremental JSON parser expected an object root.');
    }

    this.lastEmittedEnd = endIndex;
    return parsed as Partial<T>;
  }
}
