import http from 'node:http';

export interface MockChatRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockChatResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  sse?: string[];
}

export type MockChatHandler = (request: MockChatRequest) => MockChatResponse | Promise<MockChatResponse>;

export interface MockChatCompletionsServer {
  baseUrl: string;
  requests: MockChatRequest[];
  close(): Promise<void>;
}

const DEFAULT_CHAT_RESPONSE = {
  id: 'chatcmpl-default',
  object: 'chat.completion',
  model: 'mock-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'ok',
      },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 2,
  },
};

export async function startMockChatCompletionsServer(handler?: MockChatHandler): Promise<MockChatCompletionsServer> {
  const requests: MockChatRequest[] = [];
  const activeHandler = handler ?? (() => ({ json: DEFAULT_CHAT_RESPONSE }));

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    await new Promise<void>((resolve) => {
      req.on('end', () => resolve());
    });

    let parsedBody: Record<string, unknown> = {};
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      parsedBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsedBody = {};
    }

    const requestRecord: MockChatRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body: parsedBody,
    };
    requests.push(requestRecord);

    const reply = await activeHandler(requestRecord);
    const status = reply.status ?? 200;

    if (reply.sse) {
      res.statusCode = status;
      res.setHeader('content-type', 'text/event-stream');
      for (const [header, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(header, value);
      }
      const payload = `${reply.sse.join('\n\n')}\n\n`;
      res.end(payload);
      return;
    }

    if (reply.json !== undefined) {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      for (const [header, value] of Object.entries(reply.headers ?? {})) {
        res.setHeader(header, value);
      }
      res.end(JSON.stringify(reply.json));
      return;
    }

    res.statusCode = status;
    for (const [header, value] of Object.entries(reply.headers ?? {})) {
      res.setHeader(header, value);
    }
    res.end(reply.text ?? '');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock Chat Completions server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
