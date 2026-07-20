import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonExclusive(filePath, value, { mode = 0o600 } = {}) {
  const handle = await open(filePath, 'wx', mode);
  try {
    await handle.writeFile(serialized(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeJsonAtomic(filePath, value, { mode = 0o600 } = {}) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(serialized(value), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}
