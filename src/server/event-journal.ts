import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { RunEvent } from '../engine/events.js';
import type { EventEnvelope } from './types.js';

export interface ReplayOptions {
  from_seq?: number;
  on_envelope: (envelope: EventEnvelope) => Promise<void> | void;
}

export class EventJournal {
  private readonly journalPath: string;
  private initialized = false;
  private nextSeq = 1;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(journalPath: string) {
    this.journalPath = journalPath;
  }

  static async open(journalPath: string): Promise<EventJournal> {
    const journal = new EventJournal(journalPath);
    await journal.initialize();
    return journal;
  }

  getPath(): string {
    return this.journalPath;
  }

  currentSeq(): number {
    return this.nextSeq - 1;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(path.dirname(this.journalPath), { recursive: true });
    const maxSeq = await this.scanMaxSequence();
    this.nextSeq = maxSeq + 1;
    this.initialized = true;
  }

  async append(event: RunEvent): Promise<EventEnvelope> {
    await this.initialize();
    const envelope: EventEnvelope = {
      seq: this.nextSeq++,
      timestamp: new Date().toISOString(),
      event,
    };
    const line = `${JSON.stringify(envelope)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await appendFile(this.journalPath, line, 'utf8');
    });
    await this.writeChain;
    return envelope;
  }

  async replay(options: ReplayOptions): Promise<void> {
    await this.initialize();
    const fromSeq = options.from_seq ?? 0;
    if (!existsSync(this.journalPath)) {
      return;
    }

    const stream = createReadStream(this.journalPath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line || line.trim().length === 0) {
          continue;
        }
        const envelope = parseEnvelopeLine(line);
        if (!envelope || envelope.seq <= fromSeq) {
          continue;
        }
        await options.on_envelope(envelope);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async scanMaxSequence(): Promise<number> {
    if (!existsSync(this.journalPath)) {
      return 0;
    }

    let maxSeq = 0;
    const stream = createReadStream(this.journalPath, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line || line.trim().length === 0) {
          continue;
        }
        const envelope = parseEnvelopeLine(line);
        if (envelope && envelope.seq > maxSeq) {
          maxSeq = envelope.seq;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return maxSeq;
  }
}

function parseEnvelopeLine(line: string): EventEnvelope | null {
  try {
    const parsed = JSON.parse(line) as EventEnvelope;
    if (!Number.isInteger(parsed.seq) || parsed.seq <= 0) {
      return null;
    }
    if (!parsed.timestamp || typeof parsed.timestamp !== 'string') {
      return null;
    }
    if (!parsed.event || typeof parsed.event !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
