import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionResult } from './types.js';

export interface TranscriptEntry {
  role: string;
  text?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  results?: Array<{ tool_call_id: string; content: string; is_error: boolean }>;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
  stop_reason?: string;
}

export class TranscriptWriter {
  private readonly nodeDir: string;
  private initialized = false;

  constructor(nodeDir: string) {
    this.nodeDir = nodeDir;
  }

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.nodeDir, { recursive: true });
      this.initialized = true;
    }
  }

  async writePrompt(prompt: string): Promise<void> {
    await this.ensureDir();
    await writeFile(path.join(this.nodeDir, 'prompt.md'), prompt, 'utf8');
  }

  async writeResponse(text: string): Promise<void> {
    await this.ensureDir();
    await writeFile(path.join(this.nodeDir, 'response.md'), text, 'utf8');
  }

  async writeStatus(result: SessionResult & { provider?: string; model?: string; agent_duration_ms?: number }): Promise<void> {
    await this.ensureDir();
    const status = {
      status: result.status,
      provider: result.provider ?? 'unknown',
      model: result.model ?? 'unknown',
      turn_count: result.turn_count,
      tool_call_count: result.tool_call_count,
      stop_reason: result.stop_reason,
      usage: result.usage,
      agent_duration_ms: result.agent_duration_ms,
      error_message: result.error_message,
      completed_at: new Date().toISOString(),
    };
    await writeFile(path.join(this.nodeDir, 'agent-status.json'), JSON.stringify(status, null, 2), 'utf8');
  }

  async writeToolCall(
    index: number,
    name: string,
    request: Record<string, unknown>,
    result: string,
    fullResult?: string
  ): Promise<string> {
    const paddedIndex = String(index).padStart(3, '0');
    const toolDir = path.join(this.nodeDir, 'tool-calls', `${paddedIndex}-${name}`);
    await mkdir(toolDir, { recursive: true });

    await writeFile(path.join(toolDir, 'request.json'), JSON.stringify(request, null, 2), 'utf8');
    await writeFile(path.join(toolDir, 'result.json'), JSON.stringify({ content: result }, null, 2), 'utf8');

    // Write full untruncated output for shell commands
    if (fullResult) {
      await writeFile(path.join(toolDir, 'full-result.txt'), fullResult, 'utf8');
    }

    // For apply_patch, persist the raw patch text
    if (name === 'apply_patch' && request.patch && typeof request.patch === 'string') {
      await writeFile(path.join(toolDir, 'patch.txt'), request.patch as string, 'utf8');
    }

    // For shell commands, extract stdout/stderr if the result has the expected format
    if (name === 'shell') {
      const stdoutMatch = result.match(/STDOUT:\n([\s\S]*?)(?:\nSTDERR:|\n*$)/);
      const stderrMatch = result.match(/STDERR:\n([\s\S]*?)$/);
      if (stdoutMatch?.[1]) {
        await writeFile(path.join(toolDir, 'stdout.log'), stdoutMatch[1], 'utf8');
      }
      if (stderrMatch?.[1]) {
        await writeFile(path.join(toolDir, 'stderr.log'), stderrMatch[1], 'utf8');
      }
    }

    return toolDir;
  }

  async appendTranscript(entry: TranscriptEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    await appendFile(path.join(this.nodeDir, 'transcript.jsonl'), line, 'utf8');
  }

  /**
   * Create a nested TranscriptWriter for a child agent under subagents/<agentId>/
   */
  createSubagentWriter(agentId: string): TranscriptWriter {
    return new TranscriptWriter(path.join(this.nodeDir, 'subagents', agentId));
  }
}
