import { createHash } from 'node:crypto';

export function compareImmutableAwareRuntime(actualBytecode, expectedBytecode, immutableReferences) {
  const actual = runtimeBytes(actualBytecode, 'deployed runtime bytecode');
  const expected = runtimeBytes(expectedBytecode, 'compile artifact runtime bytecode');
  if (actual.length !== expected.length) throw new Error('Deployed runtime bytecode length mismatch.');
  if (!immutableReferences || typeof immutableReferences !== 'object' || Array.isArray(immutableReferences)) {
    throw new Error('Invalid immutable references.');
  }

  const immutableSlotCount = Object.keys(immutableReferences).length;
  const references = Object.values(immutableReferences).flat();
  if (immutableSlotCount === 0 || references.length < immutableSlotCount) {
    throw new Error('Unexpected immutable references.');
  }
  const covered = new Uint8Array(actual.length);
  for (const reference of references) {
    if (
      !Number.isInteger(reference?.start)
      || !Number.isInteger(reference?.length)
      || reference.start < 0
      || reference.length <= 0
      || reference.start + reference.length > actual.length
    ) {
      throw new Error('Invalid immutable reference range.');
    }
    for (let index = reference.start; index < reference.start + reference.length; index += 1) {
      if (covered[index] === 1) throw new Error('Overlapping immutable reference range.');
      covered[index] = 1;
    }
    actual.fill(0, reference.start, reference.start + reference.length);
    expected.fill(0, reference.start, reference.start + reference.length);
  }

  const actualNormalizedSha256 = createHash('sha256').update(actual).digest('hex');
  const expectedNormalizedSha256 = createHash('sha256').update(expected).digest('hex');
  return {
    mode: 'solc_immutable_references_masked_plus_getter_bindings',
    byteLength: actual.length,
    immutableSlotCount,
    immutableReferenceCount: references.length,
    actualNormalizedSha256,
    expectedNormalizedSha256,
    matches: actualNormalizedSha256 === expectedNormalizedSha256,
  };
}

function runtimeBytes(value, field) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`Invalid ${field}.`);
  }
  return Buffer.from(value.slice(2), 'hex');
}
