import { readFile, stat } from 'node:fs/promises';

export async function readBearerTokenFile(path, name) {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${name} must refer to a private regular file`);
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32 || /\s/u.test(token)) {
    throw new Error(`${name} does not contain an opaque bearer token`);
  }
  return token;
}

export async function readOptionalBearerTokenFile(path, name) {
  if (path === undefined || path.length === 0) return undefined;
  return readBearerTokenFile(path, name);
}
