import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'extension');
const output = resolve(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.name === '.DS_Store') continue;
  await cp(resolve(source, entry.name), resolve(output, entry.name), { recursive: true });
}

console.log('Built unpacked Chrome extension in dist/.');
