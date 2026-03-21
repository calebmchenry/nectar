import type { IncomingMessage, ServerResponse } from 'node:http';
import { HIVE_ASSETS, HIVE_INDEX_HTML } from '../generated/hive-assets.js';

const API_PREFIXES = ['/gardens', '/pipelines', '/events', '/seeds', '/health'];

export function tryServeHiveAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = normalizePath(url.pathname);

  if (pathname === '/') {
    writeBody(res, method, 200, 'text/html; charset=utf-8', Buffer.from(HIVE_INDEX_HTML, 'utf8'), {
      'Cache-Control': 'no-cache',
    });
    return true;
  }

  const asset = HIVE_ASSETS[pathname];
  if (asset) {
    const payload =
      asset.encoding === 'base64'
        ? Buffer.from(asset.content, 'base64')
        : Buffer.from(asset.content, 'utf8');
    writeBody(res, method, 200, asset.content_type, payload, {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return true;
  }

  if (!isApiPath(pathname) && wantsHtml(req)) {
    writeBody(res, method, 200, 'text/html; charset=utf-8', Buffer.from(HIVE_INDEX_HTML, 'utf8'), {
      'Cache-Control': 'no-cache',
    });
    return true;
  }

  return false;
}

function normalizePath(pathname: string): string {
  if (!pathname.startsWith('/')) {
    return `/${pathname}`;
  }
  return pathname;
}

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function wantsHtml(req: IncomingMessage): boolean {
  const acceptHeader = req.headers.accept;
  const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
  if (!accept) {
    return false;
  }
  return accept.includes('text/html');
}

function writeBody(
  res: ServerResponse,
  method: string,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Record<string, string>
): void {
  if (res.writableEnded) {
    return;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', body.length);
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end(body);
}
