import type { Transform } from './types.js';

export class TransformRegistry {
  private readonly transforms: Transform[] = [];

  register(transform: Transform): void {
    const existing = this.transforms.findIndex((candidate) => candidate.name === transform.name);
    if (existing >= 0) {
      this.transforms.splice(existing, 1);
    }
    this.transforms.push(transform);
  }

  unregister(name: string): boolean {
    const index = this.transforms.findIndex((transform) => transform.name === name);
    if (index < 0) {
      return false;
    }
    this.transforms.splice(index, 1);
    return true;
  }

  getAll(): Transform[] {
    return this.transforms.slice();
  }

  clear(): void {
    this.transforms.length = 0;
  }
}
