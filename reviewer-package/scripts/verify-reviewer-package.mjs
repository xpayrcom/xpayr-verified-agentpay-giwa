#!/usr/bin/env node
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWER_MANIFEST_FILENAME, verifyReviewerPackage } from '../src/reviewer-package.mjs';

function readPackageRoot(argv, moduleRoot) {
  if (argv.length === 0) return null;
  if (argv.length === 2 && argv[0] === '--package-root' && argv[1]) {
    return path.resolve(process.cwd(), argv[1]);
  }
  throw Object.assign(new Error('Usage: verify-reviewer-package.mjs [--package-root <directory>]'), {
    code: 'REVIEWER_INVALID_ARGUMENTS',
  });
}

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  let packageRoot = readPackageRoot(process.argv.slice(2), moduleRoot);
  if (!packageRoot) {
    try {
      await access(path.join(moduleRoot, REVIEWER_MANIFEST_FILENAME));
      packageRoot = moduleRoot;
    } catch {
      packageRoot = path.join(moduleRoot, 'generated', 'giwa-sepolia-reviewer-package');
    }
  }
  const result = await verifyReviewerPackage(packageRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error?.code ?? 'REVIEWER_PACKAGE_VERIFY_FAILED',
      message: error?.message ?? 'Reviewer package verification failed.',
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
