import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'hive', 'dist');
const OUTPUT = path.join(ROOT, 'src', 'generated', 'hive-assets.ts');

const MIME_BY_EXT = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const BASE64_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf']);

async function main() {
  const indexPath = path.join(DIST_DIR, 'index.html');
  const indexHtml = await readFile(indexPath, 'utf8');

  const assets = await collectAssets(DIST_DIR);
  const lines = [];
  lines.push('// src/generated/hive-assets.ts (generated - do not edit)');
  lines.push('');
  lines.push('export interface EmbeddedHiveAsset {');
  lines.push("  content_type: string;");
  lines.push("  encoding: 'utf8' | 'base64';");
  lines.push('  content: string;');
  lines.push('}');
  lines.push('');
  lines.push(`export const HIVE_INDEX_HTML = ${JSON.stringify(indexHtml)};`);
  lines.push('');
  lines.push('export const HIVE_ASSETS: Record<string, EmbeddedHiveAsset> = {');

  for (const asset of assets) {
    const key = `/${asset.relative.split(path.sep).join('/')}`;
    lines.push(`  ${JSON.stringify(key)}: {`);
    lines.push(`    content_type: ${JSON.stringify(asset.contentType)},`);
    lines.push(`    encoding: ${JSON.stringify(asset.encoding)},`);
    lines.push(`    content: ${JSON.stringify(asset.content)},`);
    lines.push('  },');
  }

  lines.push('};');
  lines.push('');

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, lines.join('\n'), 'utf8');
  process.stdout.write(`Embedded ${assets.length} Hive asset(s) into ${path.relative(ROOT, OUTPUT)}\n`);
}

async function collectAssets(rootDir) {
  const out = [];
  const queue = [''];

  while (queue.length > 0) {
    const relativeDir = queue.shift();
    const absoluteDir = path.join(rootDir, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(rootDir, relativePath);

      if (entry.isDirectory()) {
        queue.push(relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (relativePath === 'index.html') {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      const contentType = MIME_BY_EXT[extension] ?? 'application/octet-stream';
      const encoding = BASE64_EXTENSIONS.has(extension) ? 'base64' : 'utf8';
      const raw = await readFile(absolutePath);
      const content = raw.toString(encoding);

      out.push({
        relative: relativePath,
        contentType,
        encoding,
        content,
      });
    }
  }

  out.sort((a, b) => a.relative.localeCompare(b.relative));
  return out;
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
