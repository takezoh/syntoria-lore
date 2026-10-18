import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { openApiDocument } from '../apps/api/src/openapi.js';

const directory = new URL('../docs/api/', import.meta.url);
const destination = new URL('openapi.json', directory);
const filePath = fileURLToPath(destination);
const prettierConfig = (await resolveConfig(filePath)) ?? {};
const generated = await format(JSON.stringify(openApiDocument), {
  ...prettierConfig,
  filepath: filePath,
});
if (process.argv.includes('--check')) {
  const current = await readFile(destination, 'utf8').catch(() => '');
  if (current !== generated) {
    process.stderr.write('docs/api/openapi.json is stale; run npm run openapi:export.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Generated OpenAPI matches the checked-in snapshot.\n');
  }
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(destination, generated, 'utf8');
}
