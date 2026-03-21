import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  PipelineConflictError,
  PipelineDiagnosticsError,
  PipelineNotFoundError,
} from '../runtime/pipeline-service.js';

const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const DEFAULT_JSON_LIMIT_BYTES = 1_000_000;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  url: URL;
  readJson<T>(maxBytes?: number): Promise<T>;
  sendJson(status: number, body: unknown, headers?: Record<string, string>): void;
  sendText(status: number, body: string, contentType?: string): void;
}

type RouteHandler = (context: RouteContext) => Promise<void> | void;

interface RouteDefinition {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  register(method: string, pathname: string, handler: RouteHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pathname),
      handler,
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCorsHeaders(req, res);

    if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const pathSegments = splitPath(requestUrl.pathname);
    const matched = this.findRoute(method, pathSegments);

    if (!matched) {
      sendErrorResponse(res, new HttpError(404, 'NOT_FOUND', `Route not found: ${method} ${requestUrl.pathname}`));
      return;
    }

    const context: RouteContext = {
      req,
      res,
      params: matched.params,
      query: requestUrl.searchParams,
      url: requestUrl,
      readJson: async <T>(maxBytes = DEFAULT_JSON_LIMIT_BYTES) => readJsonBody<T>(req, maxBytes),
      sendJson: (status: number, body: unknown, headers?: Record<string, string>) => {
        sendJson(res, status, body, headers);
      },
      sendText: (status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
        sendText(res, status, body, contentType);
      },
    };

    try {
      await matched.route.handler(context);
    } catch (error) {
      if (res.writableEnded) {
        return;
      }
      sendErrorResponse(res, toHttpError(error));
    }
  }

  private findRoute(
    method: string,
    pathSegments: string[]
  ): { route: RouteDefinition; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== pathSegments.length) {
        continue;
      }

      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const routePart = route.segments[index]!;
        const pathPart = pathSegments[index]!;
        if (routePart.startsWith(':')) {
          params[routePart.slice(1)] = decodeURIComponent(pathPart);
          continue;
        }
        if (routePart !== pathPart) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return { route, params };
      }
    }

    return null;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.writableEnded) {
    return;
  }
  const payload = `${JSON.stringify(body)}\n`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

export function sendErrorResponse(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, {
    error: error.message,
    code: error.code,
    details: error.details,
  });
}

export async function readJsonBody<T>(req: IncomingMessage, maxBytes = DEFAULT_JSON_LIMIT_BYTES): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

export function setSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

export function writeSseEvent(res: ServerResponse, id: number, eventName: string, data: unknown): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`id: ${id}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeSseComment(res: ServerResponse, comment = 'keepalive'): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`: ${comment}\n\n`);
}

export function parseLastEventId(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof PipelineNotFoundError) {
    return new HttpError(404, 'NOT_FOUND', error.message);
  }
  if (error instanceof PipelineConflictError) {
    return new HttpError(409, 'CONFLICT', error.message);
  }
  if (error instanceof PipelineDiagnosticsError) {
    return new HttpError(400, 'VALIDATION_ERROR', error.message, { diagnostics: error.diagnostics });
  }
  const message = error instanceof Error ? error.message : 'Internal server error.';
  return new HttpError(500, 'INTERNAL_ERROR', message);
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && LOCALHOST_ORIGIN_PATTERN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Last-Event-ID');
}
