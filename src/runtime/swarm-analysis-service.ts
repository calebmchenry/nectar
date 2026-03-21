import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UnifiedClient } from '../llm/client.js';
import { LLMError, RateLimitError } from '../llm/errors.js';
import type { ContentPart, Message } from '../llm/types.js';
import { parseSeedMarkdown } from '../seedbed/markdown.js';
import { workspacePathsFromRoot } from '../seedbed/paths.js';
import { SeedStore } from '../seedbed/store.js';
import { renderAnalysisDocument } from '../seedbed/analysis-document.js';
import type { SeedMeta, SeedPriority } from '../seedbed/types.js';
import type { AnalysisOutcomeStatus, SwarmProvider } from '../server/workspace-event-bus.js';
import { WorkspaceEventBus } from '../server/workspace-event-bus.js';

const TEXT_ATTACHMENT_CAP_BYTES = 50 * 1024;
const INLINE_IMAGE_MAX_BYTES = 1 * 1024 * 1024;
const TOTAL_INLINE_ATTACHMENT_BYTES = 1 * 1024 * 1024;

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.log',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.css',
  '.html',
  '.xml',
]);

const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export const SWARM_PROVIDERS: readonly SwarmProvider[] = ['claude', 'codex', 'gemini'];

interface ProviderTarget {
  llm_provider: string;
  supports_images: boolean;
  default_model?: string;
}

const DEFAULT_PROVIDER_TARGETS: Record<SwarmProvider, ProviderTarget> = {
  claude: {
    llm_provider: 'anthropic',
    supports_images: true,
  },
  codex: {
    llm_provider: 'openai',
    supports_images: true,
  },
  gemini: {
    llm_provider: 'gemini',
    supports_images: true,
  },
};

const ANALYSIS_SYSTEM_PROMPT = [
  'You are analyzing a software idea captured as a Nectar seed.',
  'Return strict JSON matching the response schema.',
  'Use concise, practical engineering language.',
  'Do not include markdown in any field except plain text paragraphs.',
  'Be explicit about risks and open questions.',
].join(' ');

const SEED_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'recommended_priority',
    'estimated_complexity',
    'feasibility',
    'summary',
    'implementation_approach',
    'risks',
    'open_questions',
  ],
  properties: {
    recommended_priority: {
      type: 'string',
      enum: ['low', 'normal', 'high', 'queens_order'],
    },
    estimated_complexity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    feasibility: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    summary: {
      type: 'string',
      minLength: 1,
    },
    implementation_approach: {
      type: 'string',
      minLength: 1,
    },
    risks: {
      type: 'string',
      minLength: 1,
    },
    open_questions: {
      type: 'string',
      minLength: 1,
    },
  },
} as const;

interface SeedAnalysisObject {
  recommended_priority: SeedPriority;
  estimated_complexity: 'low' | 'medium' | 'high';
  feasibility: 'low' | 'medium' | 'high';
  summary: string;
  implementation_approach: string;
  risks: string;
  open_questions: string;
}

interface AttachmentDescriptor {
  filename: string;
  absolute_path: string;
  size: number;
  content_type: string;
  is_image: boolean;
  is_text: boolean;
}

export interface SwarmAnalysisServiceOptions {
  workspace_root: string;
  client?: UnifiedClient;
  event_bus?: WorkspaceEventBus;
  provider_targets?: Partial<Record<SwarmProvider, Partial<ProviderTarget>>>;
}

export interface SwarmAnalyzeOptions {
  seed_id: number;
  providers: SwarmProvider[];
  include_attachments: boolean;
  force?: boolean;
}

export interface SwarmProviderResult {
  provider: SwarmProvider;
  status: AnalysisOutcomeStatus;
  message?: string;
}

export class SwarmAnalysisService {
  readonly store: SeedStore;
  private readonly workspaceRoot: string;
  private readonly client: UnifiedClient;
  private readonly eventBus?: WorkspaceEventBus;
  private readonly providerTargets: Record<SwarmProvider, ProviderTarget>;

  constructor(options: SwarmAnalysisServiceOptions) {
    this.workspaceRoot = options.workspace_root;
    this.store = new SeedStore(workspacePathsFromRoot(options.workspace_root));
    this.client = options.client ?? UnifiedClient.from_env();
    this.eventBus = options.event_bus;
    this.providerTargets = {
      claude: {
        ...DEFAULT_PROVIDER_TARGETS.claude,
        ...options.provider_targets?.claude,
      },
      codex: {
        ...DEFAULT_PROVIDER_TARGETS.codex,
        ...options.provider_targets?.codex,
      },
      gemini: {
        ...DEFAULT_PROVIDER_TARGETS.gemini,
        ...options.provider_targets?.gemini,
      },
    };
  }

  async analyzeSeed(options: SwarmAnalyzeOptions): Promise<SwarmProviderResult[]> {
    const providers = dedupeProviders(options.providers);
    const seed = await this.store.get(options.seed_id);
    if (!seed) {
      throw new Error(`Seed ${options.seed_id} not found.`);
    }

    this.eventBus?.emit({
      type: 'seed_analysis_started',
      seed_id: options.seed_id,
      providers,
    });

    try {
      const attachments = await this.listAttachments(seed.dirPath);
      const settled = await Promise.allSettled(
        providers.map((provider) =>
          this.runProvider({
            seed_id: options.seed_id,
            provider,
            seed_dir: seed.dirPath,
            seed_markdown: seed.seedMd,
            seed_meta: seed.meta,
            attachments,
            include_attachments: options.include_attachments,
            force: options.force === true,
          })
        )
      );

      const results: SwarmProviderResult[] = settled.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        }
        return {
          provider: providers[index] ?? 'claude',
          status: 'failed',
          message: toErrorMessage(result.reason),
        };
      });

      const statuses: Partial<Record<SwarmProvider, AnalysisOutcomeStatus>> = {};
      for (const result of results) {
        statuses[result.provider] = result.status;
      }

      this.eventBus?.emit({
        type: 'seed_analysis_completed',
        seed_id: options.seed_id,
        statuses,
      });
      return results;
    } catch (error) {
      this.eventBus?.emit({
        type: 'seed_analysis_failed',
        seed_id: options.seed_id,
        error: toErrorMessage(error),
      });
      throw error;
    }
  }

  async recoverStaleRunningStatuses(reason = 'Analysis interrupted by server restart.'): Promise<number> {
    const listed = await this.store.list();
    let updated = 0;

    for (const item of listed) {
      const analysisStatus = item.meta.analysis_status;
      for (const [providerName, status] of Object.entries(analysisStatus)) {
        if (status !== 'running') {
          continue;
        }

        await this.store.patch(item.meta.id, {
          analysis_status: {
            [providerName]: 'failed',
          },
        });

        const analysisDir = path.join(item.dirPath, 'analysis');
        await mkdir(analysisDir, { recursive: true });
        const markdown = renderAnalysisDocument({
          provider: providerName,
          status: 'failed',
          error: reason,
        });
        await atomicWriteText(path.join(analysisDir, `${providerName}.md`), markdown);
        updated += 1;
      }
    }

    return updated;
  }

  private async runProvider(input: {
    seed_id: number;
    provider: SwarmProvider;
    seed_dir: string;
    seed_markdown: string;
    seed_meta: SeedMeta;
    attachments: AttachmentDescriptor[];
    include_attachments: boolean;
    force: boolean;
  }): Promise<SwarmProviderResult> {
    const provider = input.provider;
    const outputPath = path.join(input.seed_dir, 'analysis', `${provider}.md`);

    if (!input.force && input.seed_meta.analysis_status[provider] === 'complete' && (await fileExists(outputPath))) {
      const result: SwarmProviderResult = {
        provider,
        status: 'complete',
        message: 'Analysis already complete.',
      };
      this.eventBus?.emit({
        type: 'seed_analysis_provider_completed',
        seed_id: input.seed_id,
        provider,
        status: 'complete',
        message: result.message,
      });
      return result;
    }

    await this.store.patch(input.seed_id, {
      analysis_status: {
        [provider]: 'running',
      },
    });

    const target = this.providerTargets[provider];
    const isConfigured = this.client.available_providers().includes(target.llm_provider);
    const analysisDir = path.join(input.seed_dir, 'analysis');
    await mkdir(analysisDir, { recursive: true });

    if (!isConfigured) {
      const reason = `Provider '${provider}' is not configured in this workspace.`;
      const markdown = renderAnalysisDocument({
        provider,
        status: 'skipped',
        error: reason,
      });
      await atomicWriteText(outputPath, markdown);
      await this.store.patch(input.seed_id, {
        analysis_status: {
          [provider]: 'skipped',
        },
      });

      const result: SwarmProviderResult = {
        provider,
        status: 'skipped',
        message: reason,
      };
      this.eventBus?.emit({
        type: 'seed_analysis_provider_completed',
        seed_id: input.seed_id,
        provider,
        status: 'skipped',
        message: reason,
      });
      return result;
    }

    try {
      const generated = await this.generateForProvider({
        provider,
        target,
        seed_markdown: input.seed_markdown,
        seed_title: input.seed_meta.title,
        seed_priority: input.seed_meta.priority,
        seed_tags: input.seed_meta.tags,
        attachments: input.attachments,
        include_attachments: input.include_attachments,
      });

      const markdown = renderAnalysisDocument({
        provider,
        status: 'complete',
        recommended_priority: generated.recommended_priority,
        estimated_complexity: generated.estimated_complexity,
        feasibility: generated.feasibility,
        summary: generated.summary,
        implementation_approach: generated.implementation_approach,
        risks: generated.risks,
        open_questions: generated.open_questions,
      });

      await atomicWriteText(outputPath, markdown);
      await this.store.patch(input.seed_id, {
        analysis_status: {
          [provider]: 'complete',
        },
      });

      const result: SwarmProviderResult = {
        provider,
        status: 'complete',
      };
      this.eventBus?.emit({
        type: 'seed_analysis_provider_completed',
        seed_id: input.seed_id,
        provider,
        status: 'complete',
      });
      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      const markdown = renderAnalysisDocument({
        provider,
        status: 'failed',
        error: message,
      });

      await atomicWriteText(outputPath, markdown);
      await this.store.patch(input.seed_id, {
        analysis_status: {
          [provider]: 'failed',
        },
      });

      const result: SwarmProviderResult = {
        provider,
        status: 'failed',
        message,
      };
      this.eventBus?.emit({
        type: 'seed_analysis_provider_completed',
        seed_id: input.seed_id,
        provider,
        status: 'failed',
        message,
      });
      return result;
    }
  }

  private async generateForProvider(input: {
    provider: SwarmProvider;
    target: ProviderTarget;
    seed_markdown: string;
    seed_title: string;
    seed_priority: string;
    seed_tags: string[];
    attachments: AttachmentDescriptor[];
    include_attachments: boolean;
  }): Promise<SeedAnalysisObject> {
    const messages = await this.buildMessages({
      target: input.target,
      seed_markdown: input.seed_markdown,
      seed_title: input.seed_title,
      seed_priority: input.seed_priority,
      seed_tags: input.seed_tags,
      attachments: input.attachments,
      include_attachments: input.include_attachments,
    });

    const response = await this.client.generateObject<SeedAnalysisObject>({
      provider: input.target.llm_provider,
      model: input.target.default_model,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages,
      reasoning_effort: 'medium',
      timeout: { request_ms: 90_000 },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'seed_analysis',
          strict: true,
          schema: SEED_ANALYSIS_SCHEMA,
        },
      },
    });

    return {
      recommended_priority: response.object.recommended_priority,
      estimated_complexity: response.object.estimated_complexity,
      feasibility: response.object.feasibility,
      summary: normalizeBodyValue(response.object.summary, 'Summary unavailable.'),
      implementation_approach: normalizeBodyValue(
        response.object.implementation_approach,
        'Implementation approach unavailable.'
      ),
      risks: normalizeBodyValue(response.object.risks, 'Risks unavailable.'),
      open_questions: normalizeBodyValue(response.object.open_questions, 'Open questions unavailable.'),
    };
  }

  private async buildMessages(input: {
    target: ProviderTarget;
    seed_markdown: string;
    seed_title: string;
    seed_priority: string;
    seed_tags: string[];
    attachments: AttachmentDescriptor[];
    include_attachments: boolean;
  }): Promise<Message[]> {
    const parsed = parseSeedMarkdown(input.seed_markdown);
    const title = (parsed.title || input.seed_title).trim();
    const body = parsed.body.trim();

    const details: string[] = [];
    details.push(`Seed title: ${title}`);
    details.push(`Current priority: ${input.seed_priority}`);
    details.push(`Tags: ${input.seed_tags.length > 0 ? input.seed_tags.join(', ') : '(none)'}`);
    details.push('');
    details.push('Seed body:');
    details.push(body || '(empty)');
    details.push('');

    details.push('Attachments:');
    if (input.attachments.length === 0) {
      details.push('- none');
    } else {
      for (const attachment of input.attachments) {
        details.push(
          `- ${attachment.filename} (${attachment.content_type}, ${attachment.size} bytes${attachment.is_image ? ', image' : ''})`
        );
      }
    }

    let remainingInlineBudget = TOTAL_INLINE_ATTACHMENT_BYTES;

    if (input.include_attachments) {
      const excerptResult = await this.collectTextAttachmentExcerpts(input.attachments, remainingInlineBudget);
      const excerpts = excerptResult.excerpts;
      remainingInlineBudget = excerptResult.remaining_bytes;
      if (excerpts.length > 0) {
        details.push('');
        details.push('Text attachment excerpts (capped at 50KB per attachment):');
        for (const excerpt of excerpts) {
          details.push('');
          details.push(`Attachment: ${excerpt.filename}`);
          details.push(excerpt.content);
        }
      }
    }

    const textPrompt = details.join('\n');
    const parts: ContentPart[] = [{ type: 'text', text: textPrompt }];

    if (input.include_attachments && input.target.supports_images) {
      const imageResult = await this.collectInlineImageParts(input.attachments, remainingInlineBudget);
      parts.push(...imageResult.parts);
    }

    return [
      {
        role: 'user',
        content: parts.length === 1 ? textPrompt : parts,
      },
    ];
  }

  private async listAttachments(seedDirPath: string): Promise<AttachmentDescriptor[]> {
    const attachmentsDir = path.join(seedDirPath, 'attachments');
    let entries;
    try {
      entries = await readdir(attachmentsDir, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const results: AttachmentDescriptor[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const absolutePath = path.join(attachmentsDir, entry.name);
      const info = await stat(absolutePath);
      const ext = path.extname(entry.name).toLowerCase();
      const isImage = IMAGE_ATTACHMENT_EXTENSIONS.has(ext);
      const isText = TEXT_ATTACHMENT_EXTENSIONS.has(ext);
      results.push({
        filename: entry.name,
        absolute_path: absolutePath,
        size: info.size,
        content_type: contentTypeForFilename(entry.name),
        is_image: isImage,
        is_text: isText,
      });
    }

    results.sort((a, b) => a.filename.localeCompare(b.filename));
    return results;
  }

  private async collectTextAttachmentExcerpts(
    attachments: AttachmentDescriptor[],
    byteBudget: number
  ): Promise<{ excerpts: Array<{ filename: string; content: string }>; remaining_bytes: number }> {
    const excerpts: Array<{ filename: string; content: string }> = [];
    let remainingBytes = byteBudget;

    for (const attachment of attachments) {
      if (!attachment.is_text || remainingBytes <= 0) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(attachment.absolute_path, 'utf8');
      } catch {
        continue;
      }

      const buffer = Buffer.from(content, 'utf8');
      const attachmentCap = Math.min(TEXT_ATTACHMENT_CAP_BYTES, remainingBytes);
      const usedBytes = Math.min(buffer.length, attachmentCap);
      if (usedBytes <= 0) {
        continue;
      }

      if (buffer.length > attachmentCap) {
        const truncated = buffer.subarray(0, attachmentCap).toString('utf8');
        excerpts.push({
          filename: attachment.filename,
          content: `${truncated}\n...[truncated]`,
        });
      } else {
        excerpts.push({
          filename: attachment.filename,
          content,
        });
      }

      remainingBytes -= usedBytes;
    }

    return {
      excerpts,
      remaining_bytes: remainingBytes,
    };
  }

  private async collectInlineImageParts(
    attachments: AttachmentDescriptor[],
    byteBudget: number
  ): Promise<{ parts: ContentPart[]; remaining_bytes: number }> {
    const parts: ContentPart[] = [];
    let remainingBytes = byteBudget;
    for (const attachment of attachments) {
      if (
        !attachment.is_image ||
        attachment.size > INLINE_IMAGE_MAX_BYTES ||
        attachment.size > remainingBytes
      ) {
        continue;
      }

      try {
        const bytes = await readFile(attachment.absolute_path);
        if (bytes.length > remainingBytes) {
          continue;
        }
        parts.push({
          type: 'text',
          text: `Inline image attachment: ${attachment.filename}`,
        });
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.content_type,
            data: bytes.toString('base64'),
          },
        });
        remainingBytes -= bytes.length;
      } catch {
        // Ignore unreadable attachments and continue with the rest.
      }
    }
    return {
      parts,
      remaining_bytes: remainingBytes,
    };
  }
}

function normalizeBodyValue(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function dedupeProviders(providers: SwarmProvider[]): SwarmProvider[] {
  const seen = new Set<SwarmProvider>();
  const deduped: SwarmProvider[] = [];
  for (const provider of providers) {
    if (!SWARM_PROVIDERS.includes(provider) || seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    deduped.push(provider);
  }
  return deduped.length > 0 ? deduped : [...SWARM_PROVIDERS];
}

function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webp') return 'image/webp';
  if (TEXT_ATTACHMENT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof RateLimitError) {
    if (typeof error.retry_after_ms === 'number' && error.retry_after_ms > 0) {
      return `Rate limited (429). Retry after ${Math.ceil(error.retry_after_ms / 1000)}s.`;
    }
    return 'Rate limited (429).';
  }
  if (error instanceof LLMError && error.status_code === 429) {
    return 'Rate limited (429).';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
