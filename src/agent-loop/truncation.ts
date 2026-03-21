/**
 * Head/tail character-based truncation for tool output,
 * with a secondary line-cap pass for high-volume tools.
 */

/** Per-tool line caps for the second truncation pass */
export const TOOL_LINE_CAPS: Record<string, number> = {
  shell: 256,
  grep: 200,
  glob: 500,
  read_many_files: 1_000,
  list_dir: 800,
};

export function truncateForModel(text: string, limit: number): string {
  if (text.length <= limit) {
    // Even if under char limit, apply line cap if applicable
    return text;
  }

  const headSize = Math.ceil(limit / 2);
  const tailSize = limit - headSize;
  const omitted = text.length - headSize - tailSize;

  const head = text.slice(0, headSize);
  const tail = text.slice(text.length - tailSize);

  let result = `${head}\n\n[WARNING: Tool output was truncated. ${omitted} characters were removed from the middle. The full output is available in the event stream. If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n${tail}`;

  // Secondary pass: if the result is a single enormous line, apply line-based splitting
  if (!result.includes('\n') && result.length > limit) {
    const lines: string[] = [];
    for (let i = 0; i < result.length; i += 200) {
      lines.push(result.slice(i, i + 200));
    }
    result = lines.join('\n');
  }

  return result;
}

/**
 * Two-pass truncation: character cap then line cap.
 * Returns { preview, truncated } so callers can preserve full output.
 */
export function truncateToolOutput(
  toolName: string,
  raw: string,
  charLimit: number,
  lineCaps: Record<string, number> = TOOL_LINE_CAPS,
): { preview: string; truncated: boolean } {
  let preview = raw;
  let truncated = false;

  // First pass: character truncation
  if (preview.length > charLimit) {
    preview = truncateForModel(preview, charLimit);
    truncated = true;
  }

  // Second pass: line cap for tools that produce many lines
  const lineCap = lineCaps[toolName];
  if (lineCap) {
    const lines = preview.split('\n');
    if (lines.length > lineCap) {
      const headCount = Math.ceil(lineCap / 2);
      const tailCount = lineCap - headCount;
      const omitted = lines.length - headCount - tailCount;
      const headLines = lines.slice(0, headCount);
      const tailLines = lines.slice(lines.length - tailCount);
      preview = `${headLines.join('\n')}\n[... ${omitted} lines omitted ...]\n${tailLines.join('\n')}`;
      truncated = true;
    }
  }

  return { preview, truncated };
}
