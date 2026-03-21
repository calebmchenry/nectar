const ATTACHMENTS_HEADING = /^##\s+attachments\b/im;

export interface ParsedSeedMarkdown {
  title: string;
  body: string;
  attachments_section: string;
}

export function parseSeedMarkdown(source: string): ParsedSeedMarkdown {
  const normalized = source.replace(/\r\n/g, '\n').trim();
  const lines = normalized.length > 0 ? normalized.split('\n') : [];

  let title = '';
  let contentLines = lines.slice();
  const firstLine = contentLines[0]?.trim() ?? '';
  if (firstLine.startsWith('# ')) {
    title = firstLine.slice(2).trim();
    contentLines = contentLines.slice(1);
    if (contentLines[0]?.trim() === '') {
      contentLines = contentLines.slice(1);
    }
  }

  const content = contentLines.join('\n').trim();
  const match = ATTACHMENTS_HEADING.exec(content);

  if (!match || match.index < 0) {
    return {
      title,
      body: content,
      attachments_section: '',
    };
  }

  return {
    title,
    body: content.slice(0, match.index).trim(),
    attachments_section: content.slice(match.index).trim(),
  };
}

export function renderSeedMarkdown(title: string, body: string, attachmentsSection = ''): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (body.trim()) {
    lines.push(body.trim());
  }

  if (attachmentsSection.trim()) {
    if (lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(attachmentsSection.trim());
  }

  lines.push('');
  return lines.join('\n');
}

export function appendAttachmentLinks(existing: string, links: { name: string; relativePath: string }[]): string {
  if (links.length === 0) {
    return existing;
  }

  let result = existing.trimEnd();
  if (!result.includes('## Attachments')) {
    result += '\n\n## Attachments\n';
  }

  for (const link of links) {
    result += `\n- [${link.name}](${link.relativePath})`;
  }

  result += '\n';
  return result;
}
