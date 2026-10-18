import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const roots = [
  '.dockerignore',
  '.env.example',
  '.github',
  '.gitignore',
  '.node-version',
  'ARCHITECTURE.md',
  'apps',
  'Dockerfile',
  'PRODUCT.md',
  'README.md',
  'compose.yaml',
  'docs/DEVELOPMENT_PLAN.md',
  'docs/adr',
  'docs/api',
  'docs/design',
  'docs/development.md',
  'docs/eval',
  'docs/technical',
  'docs/templates',
  'docs/usage',
  'eslint.config.mjs',
  'infra',
  'package-lock.json',
  'package.json',
  'packages',
  'scripts',
  'tests',
  'tsconfig.base.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'vitest.config.ts',
];
const excludedSegments = new Set(['.git', 'dist', 'node_modules', 'var']);
const excludedFiles = new Set(['docs/eval/local-acceptance.md']);

async function walk(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(
      entries
        .filter((entry) => !excludedSegments.has(entry.name))
        .map((entry) => walk(resolve(path, entry.name))),
    );
    return nested.flat();
  }
  if (!info.isFile()) return [];
  const rel = relative(root, path).split(sep).join('/');
  if (excludedFiles.has(rel) || rel === '.env.local') return [];
  return [{ path, rel }];
}

const files = (await Promise.all(roots.map((name) => walk(resolve(root, name))))).flat();
files.sort((left, right) => left.rel.localeCompare(right.rel));

const digest = createHash('sha256');
for (const file of files) {
  digest.update(file.rel, 'utf8');
  digest.update('\0');
  digest.update(await readFile(file.path));
  digest.update('\0');
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'memory.local-source-config-digest.v1',
      algorithm: 'sha256(path NUL bytes NUL for each sorted included file)',
      included_file_count: files.length,
      excluded: [
        '.git',
        'node_modules',
        '**/dist/**',
        'var/**',
        '.env.local',
        'docs/eval/local-acceptance.md',
      ],
      digest: digest.digest('hex'),
    },
    null,
    2,
  )}\n`,
);
