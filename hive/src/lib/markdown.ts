function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeHref(rawHref: string): string {
  const href = rawHref.trim();
  if (/^(https?:\/\/|\/)/i.test(href)) {
    return href;
  }
  return '#';
}

function renderInlineMarkdown(value: string): string {
  let rendered = escapeHtml(value);
  rendered = rendered.replace(/`([^`]+)`/g, '<code>$1</code>');
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, href: string) => {
    const safe = safeHref(href);
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return rendered;
}

export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];

  let inList = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1]!.length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2]!)}</h${level}>`);
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(listMatch[1]!)}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}
