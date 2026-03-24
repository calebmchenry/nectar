import { existsSync } from 'node:fs';
import path from 'node:path';

const SHELL_BUILTINS = new Set([
  'alias',
  'bg',
  'break',
  'builtin',
  'cd',
  'command',
  'continue',
  'dirs',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fg',
  'getopts',
  'hash',
  'history',
  'jobs',
  'kill',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'source',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
]);

const GNU_PORTABILITY_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'grep -P', pattern: /\bgrep\b[^\n]*\s-(?:[A-Za-z]*P[A-Za-z]*)\b/ },
  { label: 'grep -oP', pattern: /\bgrep\b[^\n]*\s-oP\b/ },
  { label: 'sed -r', pattern: /\bsed\b[^\n]*\s-r\b/ },
  { label: 'find -printf', pattern: /\bfind\b[^\n]*\s-printf\b/ },
  { label: 'readlink -f', pattern: /\breadlink\b[^\n]*\s-f\b/ },
];

export function extractToolCommandHead(command: string): string | undefined {
  const tokens = tokenizeCommand(command.trim());
  for (const token of tokens) {
    if (isEnvAssignmentToken(token)) {
      continue;
    }
    return token;
  }
  return undefined;
}

export function isPathLikeCommandHead(head: string): boolean {
  return head.startsWith('/') || head.startsWith('./') || head.startsWith('../');
}

export function isShellBuiltin(head: string): boolean {
  return SHELL_BUILTINS.has(head);
}

export function isExecutableOnPath(head: string, pathValue = process.env.PATH ?? ''): boolean {
  if (!head || head.includes(path.sep)) {
    return false;
  }

  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    if (existsSync(path.join(dir, head))) {
      return true;
    }
  }

  if (process.platform === 'win32') {
    const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((entry) => entry.toLowerCase());
    for (const dir of pathEntries) {
      for (const ext of extensions) {
        if (existsSync(path.join(dir, `${head}${ext}`))) {
          return true;
        }
      }
    }
  }

  return false;
}

export function detectPortabilityRisks(command: string): string[] {
  const risks: string[] = [];
  for (const rule of GNU_PORTABILITY_RULES) {
    if (rule.pattern.test(command)) {
      risks.push(rule.label);
    }
  }
  return risks;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== '\'') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (char === ';' || char === '|' || char === '&') {
      if (current) {
        tokens.push(current);
      }
      break;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}
