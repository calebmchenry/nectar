import type { GenerateRequest, GenerateResponse } from './types.js';
import type { StreamEvent } from './streaming.js';

export type GenerateFn = (request: GenerateRequest) => Promise<GenerateResponse>;
export type StreamFn = (request: GenerateRequest) => AsyncIterable<StreamEvent>;

export interface Middleware {
  name: string;
  generate?(
    request: GenerateRequest,
    next: GenerateFn
  ): Promise<GenerateResponse>;
  stream?(
    request: GenerateRequest,
    next: StreamFn
  ): AsyncIterable<StreamEvent>;
}

/**
 * Compose a chain of middleware for the generate path.
 * Registration order = request processing order.
 * Response processing is naturally reversed (inner-to-outer).
 */
export function composeGenerateChain(
  middlewares: Middleware[],
  terminal: GenerateFn
): GenerateFn {
  let chain = terminal;

  // Build from right to left so the first middleware wraps outermost
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i]!;
    if (mw.generate) {
      const next = chain;
      const generateFn = mw.generate.bind(mw);
      chain = (request: GenerateRequest) => generateFn(request, next);
    }
  }

  return chain;
}

/**
 * Compose a chain of middleware for the stream path.
 * Same ordering semantics as generate.
 */
export function composeStreamChain(
  middlewares: Middleware[],
  terminal: StreamFn
): StreamFn {
  let chain = terminal;

  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i]!;
    if (mw.stream) {
      const next = chain;
      const streamFn = mw.stream.bind(mw);
      chain = (request: GenerateRequest) => streamFn(request, next);
    }
  }

  return chain;
}
