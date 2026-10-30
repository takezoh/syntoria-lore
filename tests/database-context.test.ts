import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = 'packages/db/src/index.ts';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

describe('database context', () => {
  it('is set only by the shared helper, so every transaction also sets compartments', async () => {
    const files: string[] = [];
    for (const group of ['packages', 'apps']) {
      for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(root, group, entry.name, 'src');
        try {
          files.push(...(await sourceFiles(source)));
        } catch {
          // A workspace without sources has nothing to check.
        }
      }
    }
    const setters: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/set_config\(\s*'app\./.test(text)) setters.push(relative(root, file));
    }
    expect(files.length).toBeGreaterThan(20);
    expect(setters).toEqual([helper]);
  });
});
