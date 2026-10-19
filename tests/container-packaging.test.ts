import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isExcludedBuildContextPath } from '../scripts/cloud-build-context-policy.mjs';

describe('sanitized build context exclusions', () => {
  it('copies the packaging contract and required verification inputs into the image build stage', async () => {
    const dockerfile = await readFile(join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY Dockerfile .dockerignore .gcloudignore ./');
    expect(dockerfile).toContain('COPY infra ./infra');
    expect(dockerfile).not.toContain('cloud-oauth');
  });

  it('includes only the exact repository secret scanner exception', async () => {
    expect(isExcludedBuildContextPath('scripts/secret-scan.mjs')).toBe(false);
    expect(isExcludedBuildContextPath('.env.example')).toBe(false);
    expect(isExcludedBuildContextPath('packages/api/src/index.ts')).toBe(false);

    for (const path of [
      'scripts/secret-fixture.mjs',
      'scripts/worker-secret.json',
      'config/secret.json',
      'config/credentials.json',
      'infra/cloud/secrets/service.json',
      'infra/cloud/worker-credential-directory/config.json',
      '.env.production',
      'packages/api/tsconfig.tsbuildinfo',
      'keys/service.pem',
      'node_modules/scripts/secret-scan.mjs',
      'infra/cloud/credentials-contract.json',
    ]) {
      expect(isExcludedBuildContextPath(path), `must exclude ${path}`).toBe(true);
    }

    for (const filename of ['.dockerignore', '.gcloudignore']) {
      const rules = (await readFile(join(process.cwd(), filename), 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      expect(rules).toContain('**/*secret*');
      expect(rules).toContain('!scripts/secret-scan.mjs');
      expect(rules).toContain('**/*credential*');
      expect(rules).toContain('**/*.tsbuildinfo');
      expect(rules).toContain('**/.env');
      expect(rules).toContain('**/.env.*');
      expect(rules).toContain('**/*.pem');
      expect(rules).toContain('**/*.key');
      expect(rules).toContain('**/*.log');
      expect(rules).toContain('**/.cache');
      expect(rules).toContain('**/.tmp');
      expect(rules.filter((line) => line.startsWith('!'))).toEqual([
        '!**/.env.example',
        '!scripts/secret-scan.mjs',
      ]);
    }
  });
});
