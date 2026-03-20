export function renderSeedMarkdown(title: string, body: string): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (body.trim()) {
    lines.push(body.trim());
    lines.push('');
  }
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
