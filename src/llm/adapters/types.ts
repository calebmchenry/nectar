import type { GenerateRequest, GenerateResponse } from '../types.js';
import type { StreamEvent } from '../streaming.js';

export interface ProviderAdapter {
  readonly provider_name: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
}
