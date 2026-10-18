import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const ignoredDirectories = new Set([
  '.git',
  '.codex',
  '.dev-skills',
  'node_modules',
  'dist',
  'coverage',
  'var',
]);
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
  '.sh',
]);
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
const findings = [];
await walk(root.pathname);
if (findings.length > 0) {
  process.stderr.write(
    `${findings.map((item) => `${item.file}:${item.line}: ${item.rule}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('Secret scan passed for source and documentation files.\n');
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) await scan(path);
  }
}

async function scan(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const [rule, pattern] of patterns) {
      if (pattern.test(line))
        findings.push({ file: relative(root.pathname, path), line: index + 1, rule });
    }
  }
}
