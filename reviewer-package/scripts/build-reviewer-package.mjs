#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewerPackage } from '../src/reviewer-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const result = await buildReviewerPackage(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error?.code ?? 'REVIEWER_PACKAGE_BUILD_FAILED',
      message: error?.message ?? 'Reviewer package build failed.',
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
