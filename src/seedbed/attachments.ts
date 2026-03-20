import { copyFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50 MB

export function sanitizeFilename(name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'attachment';
  return sanitized + ext.toLowerCase();
}

export async function importAttachment(
  sourcePath: string,
  attachmentsDir: string,
): Promise<{ name: string; relativePath: string }> {
  const info = await stat(sourcePath);
  if (info.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(
      `Attachment "${path.basename(sourcePath)}" is ${(info.size / 1024 / 1024).toFixed(1)} MB, exceeding the 50 MB limit.`
    );
  }

  let filename = sanitizeFilename(path.basename(sourcePath));

  // Handle collisions with numeric suffix
  let existing: string[];
  try {
    existing = await readdir(attachmentsDir);
  } catch {
    existing = [];
  }

  if (existing.includes(filename)) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let counter = 1;
    while (existing.includes(`${base}-${counter}${ext}`)) {
      counter++;
    }
    filename = `${base}-${counter}${ext}`;
  }

  const destPath = path.join(attachmentsDir, filename);
  await copyFile(sourcePath, destPath);

  return {
    name: filename,
    relativePath: `attachments/${filename}`,
  };
}
