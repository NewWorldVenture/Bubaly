import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('resolves the actual webpack loader from a repository path containing spaces and #', () => {
  const tempRoot = resolve(tmpdir());
  const ownedDirectory = mkdtempSync(join(tempRoot, 'bubaly-webpack-loader-'));
  const copiedRepository = join(ownedDirectory, 'repository with spaces #1');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  try {
    for (const path of [
      'next.config.mjs',
      'lib/security/csp.mjs',
      'lib/build-identity.mjs',
      'scripts/react-hydration-replay-fix.cjs',
    ]) {
      const target = join(copiedRepository, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repository, path), target);
    }
    const inspectConfig = `
      const { default: config } = await import(process.argv[1]);
      const compiled = config.webpack({ module: { rules: [] } }, {});
      const rule = compiled.module.rules.find(rule =>
        rule.use?.some(loader => loader.loader.endsWith('react-hydration-replay-fix.cjs'))
      );
      if (!rule) throw new Error('The actual React replay loader rule is missing');
      process.stdout.write(JSON.stringify(rule.use[0].loader));
    `;
    const loader = JSON.parse(execFileSync(process.execPath, [
      '--input-type=module', '-e', inspectConfig,
      pathToFileURL(join(copiedRepository, 'next.config.mjs')).href,
    ], { encoding: 'utf8', env: process.env }));
    expect(loader).toBe(join(copiedRepository, 'scripts/react-hydration-replay-fix.cjs'));
    expect(existsSync(loader)).toBe(true);
  } finally {
    if (dirname(resolve(ownedDirectory)) !== tempRoot) {
      throw new Error('Refusing to remove a directory outside the owned temporary test root');
    }
    rmSync(ownedDirectory, { recursive: true, force: true });
  }
});
