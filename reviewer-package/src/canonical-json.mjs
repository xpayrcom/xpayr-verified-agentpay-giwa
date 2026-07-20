import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError, invariant } from './errors.mjs';

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype']);

function normalize(value, path, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'NON_CANONICAL_NUMBER', `Non-finite number at ${path}.`);
    invariant(!Object.is(value, -0), 'NON_CANONICAL_NUMBER', `Negative zero is not allowed at ${path}.`);
    invariant(Number.isSafeInteger(value), 'NON_CANONICAL_NUMBER', `Only safe integers are allowed at ${path}.`);
    return value;
  }

  if (typeof value === 'bigint') {
    throw new DomainError(
      'NON_CANONICAL_BIGINT',
      `BigInt at ${path} must be encoded as a base-10 string before canonicalization.`,
    );
  }

  invariant(
    typeof value !== 'undefined' && typeof value !== 'function' && typeof value !== 'symbol',
    'NON_CANONICAL_VALUE',
    `Unsupported value at ${path}.`,
  );

  invariant(!ancestors.has(value), 'CYCLIC_VALUE', `Cyclic value at ${path}.`);
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalize(entry, `${path}[${index}]`, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    invariant(
      prototype === Object.prototype || prototype === null,
      'NON_PLAIN_OBJECT',
      `Only plain objects are allowed at ${path}.`,
    );

    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      invariant(!FORBIDDEN_OBJECT_KEYS.has(key), 'FORBIDDEN_KEY', `Forbidden key at ${path}.${key}.`);
      normalized[key] = normalize(value[key], `${path}.${key}`, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalValue(value) {
  return normalize(value, '$', new Set());
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value) {
  const input = typeof value === 'string' ? value : canonicalJson(value);
  return `0x${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left.replace(/^0x/, ''), 'hex');
  const rightBuffer = Buffer.from(right.replace(/^0x/, ''), 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function deepClone(value) {
  return JSON.parse(canonicalJson(value));
}
