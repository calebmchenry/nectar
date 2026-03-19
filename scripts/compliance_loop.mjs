#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const action = process.argv[2];
const args = process.argv.slice(3);
const runId = process.env.POLLINATOR_RUN_ID ?? 'unknown-run';
const runDir = process.env.POLLINATOR_RUN_DIR;

if (!runDir) {
  console.error('POLLINATOR_RUN_DIR is required.');
  process.exit(2);
}

await mkdir(runDir, { recursive: true });

const statePath = path.join(runDir, 'state.json');
const state = await loadState(statePath);

switch (action) {
  case 'audit':
    await handleAudit(state, statePath);
    break;
  case 'draft':
    await handleDraft(state, statePath, readFlag(args, '--provider') ?? 'unknown');
    break;
  case 'critique':
    await handleCritique(state, statePath, readFlag(args, '--provider') ?? 'unknown');
    break;
  case 'merge':
    await handleMerge(state, statePath);
    break;
  case 'fetch-weather':
    await handleFetchWeather(state, statePath);
    break;
  case 'implement':
    await handleImplement(state, statePath);
    break;
  case 'validate':
    await handleValidate(state, statePath);
    break;
  default:
    console.error(`Unknown action '${action ?? '<missing>'}'.`);
    process.exit(2);
}

async function handleAudit(state, statePath) {
  if (state.validated) {
    console.log(`[${runId}] audit: workspace is compliant.`);
    await saveState(statePath, state);
    process.exit(0);
  }

  console.error(`[${runId}] audit: compliance gaps remain.`);
  await saveState(statePath, state);
  process.exit(1);
}

async function handleDraft(state, statePath, provider) {
  state.drafts = Array.isArray(state.drafts) ? state.drafts : [];
  state.drafts.push(provider);
  console.log(`[${runId}] draft: produced sprint draft with ${provider}.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function handleCritique(state, statePath, provider) {
  state.critiques = Array.isArray(state.critiques) ? state.critiques : [];
  state.critiques.push(provider);
  console.log(`[${runId}] critique: reviewed draft with ${provider}.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function handleMerge(state, statePath) {
  console.log(`[${runId}] merge: unified sprint output.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function handleFetchWeather(state, statePath) {
  console.log(`[${runId}] fetch-weather: forecast is clear and deterministic.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function handleImplement(state, statePath) {
  state.implement_attempts = Number.isFinite(state.implement_attempts) ? state.implement_attempts : 0;
  state.implement_attempts += 1;

  if (state.implement_attempts === 1) {
    console.error(`[${runId}] implement: simulated first-attempt failure.`);
    await saveState(statePath, state);
    process.exit(1);
  }

  console.log(`[${runId}] implement: succeeded on attempt ${state.implement_attempts}.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function handleValidate(state, statePath) {
  state.validated = true;
  console.log(`[${runId}] validate: compliance flag set true.`);
  await saveState(statePath, state);
  process.exit(0);
}

async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      validated: Boolean(parsed.validated),
      implement_attempts: Number(parsed.implement_attempts ?? 0),
      drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
      critiques: Array.isArray(parsed.critiques) ? parsed.critiques : []
    };
  } catch {
    return {
      validated: false,
      implement_attempts: 0,
      drafts: [],
      critiques: []
    };
  }
}

async function saveState(statePath, state) {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(statePath, payload, 'utf8');
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}
