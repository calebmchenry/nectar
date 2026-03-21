import { createServer } from 'node:http';

let cachedCanListen: boolean | null = null;

export async function canListenOnLoopback(): Promise<boolean> {
  if (cachedCanListen !== null) {
    return cachedCanListen;
  }

  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    cachedCanListen = true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      cachedCanListen = false;
    } else {
      throw error;
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).catch(() => {
      // ignore close races when listen failed
    });
  }

  return cachedCanListen ?? false;
}
