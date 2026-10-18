import { sep } from 'node:path';

export function isExcludedBuildContextPath(relativePath) {
  const components = relativePath.split(sep);
  const basename = components.at(-1) ?? '';
  if (
    components.some((part) =>
      ['.git', 'node_modules', 'dist', 'coverage', '.cache', '.tmp'].includes(part),
    )
  ) {
    return true;
  }
  if (/^\.env(?:\.|$)/.test(basename) && basename !== '.env.example') return true;
  if (basename.endsWith('.tsbuildinfo')) return true;
  if (/\.(?:pem|key|p12|pfx|log)$/i.test(basename)) return true;
  const isRepositorySecretScanner = relativePath.split(sep).join('/') === 'scripts/secret-scan.mjs';
  if (
    !isRepositorySecretScanner &&
    components.some((component) => /(?:secret|credential)/i.test(component))
  ) {
    return true;
  }
  return false;
}
