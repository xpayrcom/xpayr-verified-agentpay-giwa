#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'public', 'agentpay-wallet.js');
const check = process.argv.slice(2).includes('--check');
const result = await build({
  entryPoints: [path.join(root, 'browser', 'agentpay-wallet.mjs')],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'XPayrAgentPayWallet',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  write: !check,
});

if (check) {
  const [generated, checkedIn] = await Promise.all([
    Promise.resolve(Buffer.from(result.outputFiles[0].contents)),
    readFile(outfile),
  ]);
  if (!generated.equals(checkedIn)) {
    throw new Error('public/agentpay-wallet.js is stale; run node scripts/build-wallet-client.mjs.');
  }
  process.stdout.write('Checked public/agentpay-wallet.js\n');
} else {
  process.stdout.write('Built public/agentpay-wallet.js\n');
}
