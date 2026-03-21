import type { GenerateRequest, GenerateResponse } from '../types.js';
import type { StreamEvent } from '../streaming.js';

export type ToolChoiceMode = 'auto' | 'none' | 'required' | 'named';

export interface ProviderAdapter {
  readonly provider_name: string;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
  supports_tool_choice(mode: ToolChoiceMode): boolean;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
}
