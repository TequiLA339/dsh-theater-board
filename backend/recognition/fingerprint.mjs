import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleById } from '../modules.mjs';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Hash code bytes, not the imported module cache. Editing another module must not
// invalidate this module; editing shared parsing code must invalidate all six.
export async function validationFingerprint(moduleId, root = backendRoot) {
  if (!moduleById.has(moduleId)) throw new Error('Unsupported module');
  const files = ['modules.mjs', 'validate-workbook.mjs', 'job-worker.mjs', '../package.json', '../package-lock.json'];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && /\.(mjs|json)$/.test(name)) files.push(name);
    }
  }
  await walk('recognition');
  await walk(`modules/${moduleId}`);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    let bytes;
    // npm/Git-installed packages (DSH plugin) never carry package-lock.json; the hash is unchanged when it exists.
    try { bytes = await readFile(resolve(root, file)); }
    catch (error) { if (error.code === 'ENOENT' && file === '../package-lock.json') continue; throw error; }
    hash.update(file).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}
