#!/usr/bin/env tsx
/**
 * Smoke test: runs one real LLM request per configured provider.
 * Manual use only — NOT part of CI.
 *
 * Usage: npm run test:smoke:llm
 */

import { UnifiedClient } from './client.js';

async function main() {
  const client = UnifiedClient.from_env();
  const providers = client.available_providers().filter((p) => p !== 'simulation');

  if (providers.length === 0) {
    console.log('No API keys configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run smoke tests.');
    process.exit(0);
  }

  console.log(`Configured providers: ${providers.join(', ')}\n`);

  for (const provider of providers) {
    console.log(`--- Testing ${provider} ---`);
    try {
      const events: string[] = [];
      for await (const event of client.stream({
        messages: [{ role: 'user', content: 'Say "smoke test passed" and nothing else.' }],
        provider,
        max_tokens: 50
      })) {
        if (event.type === 'content_delta') {
          process.stdout.write(event.text);
          events.push(event.text);
        }
        if (event.type === 'usage') {
          console.log(`\nUsage: ${JSON.stringify(event.usage)}`);
        }
        if (event.type === 'stream_end') {
          console.log(`Stop reason: ${event.stop_reason}`);
        }
      }
      console.log(`✓ ${provider} smoke test passed\n`);
    } catch (error) {
      console.error(`✗ ${provider} smoke test failed: ${error instanceof Error ? error.message : error}\n`);
    }
  }
}

main().catch(console.error);
