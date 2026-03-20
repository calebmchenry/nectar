import type { ExecutionEnvironment } from '../execution-environment.js';
import { parsePatchV4A, applyParsedPatch, PatchParseError } from '../patch.js';

export const applyPatchDescription = 'Apply a patch to files in the workspace. Uses the v4a patch format with "*** Begin Patch" / "*** End Patch" envelope. Supports Add, Update, Delete, and Move operations. Changes are applied atomically — all hunks must succeed or no files are modified.';

export const applyPatchSchema = {
  properties: {
    patch: {
      type: 'string',
      description: 'The patch content in v4a format. Must be wrapped in "*** Begin Patch" / "*** End Patch" envelope.',
    },
  },
  required: ['patch'],
};

export async function applyPatchHandler(
  args: Record<string, unknown>,
  env: ExecutionEnvironment
): Promise<string> {
  const patch = args.patch as string;

  if (!patch || typeof patch !== 'string') {
    throw new Error('patch argument is required and must be a string');
  }

  let operations;
  try {
    operations = parsePatchV4A(patch);
  } catch (err) {
    if (err instanceof PatchParseError) {
      throw new Error(`Patch parse error: ${err.message}`);
    }
    throw err;
  }

  const result = await applyParsedPatch(operations, env);

  if (!result.success) {
    throw new Error(`Patch failed: ${result.error}`);
  }

  const summary = [
    `Patch applied successfully.`,
    `Files added: ${result.files_added}`,
    `Files modified: ${result.files_modified}`,
    `Files deleted: ${result.files_deleted}`,
  ];

  for (const op of result.operations) {
    if (op.move_to) {
      summary.push(`  ${op.type}: ${op.path} → ${op.move_to}`);
    } else {
      summary.push(`  ${op.type}: ${op.path}`);
    }
  }

  return summary.join('\n');
}
