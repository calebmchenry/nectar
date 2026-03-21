import path from 'node:path';
import { Command } from 'commander';
import { startServer } from '../../server/server.js';

interface ServeOptions {
  port: number;
  host: string;
  workspace: string;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Nectar HTTP runtime.')
    .option('--port <port>', 'Port to bind (default: 4140)', parsePort, 4140)
    .option('--host <host>', 'Host to bind (default: 127.0.0.1)', '127.0.0.1')
    .option('--workspace <path>', 'Workspace root (default: current directory)', '.')
    .action(async (options: ServeOptions) => {
      const workspaceRoot = path.resolve(options.workspace);
      const server = await startServer({
        host: options.host,
        port: options.port,
        workspace_root: workspaceRoot,
      });
      await server.waitForShutdown();
    });
}

function parsePort(input: string): number {
  const parsed = Number.parseInt(input, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port '${input}'. Expected an integer between 1 and 65535.`);
  }
  return parsed;
}
