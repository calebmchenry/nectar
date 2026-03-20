#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const GENERATED_DIR = path.join(REPO_ROOT, 'src', 'generated');
const GENERATED_FILE = path.join(GENERATED_DIR, 'version.ts');

function escapeForSingleQuotedString(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function readVersion() {
  const envVersion = process.env.NECTAR_VERSION?.trim();
  if (envVersion) {
    return envVersion.replace(/^v/, '');
  }

  const packageJsonRaw = await readFile(PACKAGE_JSON_PATH, 'utf8');
  const packageJson = JSON.parse(packageJsonRaw);
  const packageVersion = String(packageJson.version ?? '').trim();
  if (!packageVersion) {
    throw new Error('Could not determine version from NECTAR_VERSION or package.json');
  }

  return packageVersion.replace(/^v/, '');
}

async function main() {
  const version = await readVersion();
  const contents = [
    '// src/generated/version.ts (generated - do not edit)',
    `export const NECTAR_VERSION = '${escapeForSingleQuotedString(version)}';`,
    ''
  ].join('\n');

  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(GENERATED_FILE, contents, 'utf8');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
