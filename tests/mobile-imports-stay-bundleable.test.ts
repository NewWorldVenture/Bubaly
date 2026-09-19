import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Metro bundles only what it WATCHES. mobile/metro.config.js adds the repo's
// `design` and `shared` folders for exactly that reason, and pins
// nodeModulesPaths so the app can never pull the web app's React.
//
// mobile/src also imports `../../../lib/database.types`, which is NOT watched.
// That is safe today only because both sites use `import type` and the file has
// no runtime exports, so TypeScript erases it before Metro ever sees it.
//
// Nothing enforced that. `tsc` resolves the path happily, and CI's mobile job
// runs `typecheck` + `expo config` — it never bundles. So turning one
// `import type` into `import`, or adding a runtime export (an enum, a const) to
// database.types.ts, would break the mobile bundle with every check still green.
// The failure would first appear in a real/EAS build.

const ROOT = resolve(__dirname, '..');
const MOBILE_SOURCE = ['mobile/src', 'mobile/app'];

/** The folders Metro is configured to watch, read from the config itself. */
function watchedRoots(): string[] {
  const cfg = readFileSync(join(ROOT, 'mobile/metro.config.js'), 'utf8');
  // path.resolve(projectRoot, '..', 'design') -> "design"
  return [...cfg.matchAll(/path\.resolve\(\s*projectRoot\s*,\s*'\.\.'\s*,\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
}

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  let entries: string[] = [];
  try { entries = readdirSync(abs); } catch { return []; }
  return entries.flatMap((e) => {
    const p = join(dir, e);
    if (statSync(join(ROOT, p)).isDirectory()) return walk(p);
    return /\.tsx?$/.test(e) ? [p] : [];
  });
}

type Escape = { file: string; root: string; spec: string; typeOnly: boolean };

function escapingImports(): Escape[] {
  const out: Escape[] = [];
  for (const file of MOBILE_SOURCE.flatMap(walk)) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    // Any import that climbs out of mobile/ entirely.
    for (const m of src.matchAll(/import\s+(type\s+)?[^'"]*from\s+'((?:\.\.\/){3,}[^']+)'/g)) {
      const root = m[2].replace(/^(\.\.\/)+/, '').split('/')[0];
      out.push({ file, root, spec: m[2], typeOnly: Boolean(m[1]) });
    }
  }
  return out;
}

describe('mobile imports stay bundleable by Metro', () => {
  it('finds the out-of-package imports at all (guards the guard)', () => {
    // If this parser silently matched nothing, every assertion below would pass
    // vacuously — which is the defect class this repository keeps finding.
    const escapes = escapingImports();
    expect(escapes.length).toBeGreaterThan(0);
    expect(escapes.map((e) => e.root)).toContain('lib');
  });

  it('reads Metro\'s watch list from the config, not from a copy of it', () => {
    const roots = watchedRoots();
    expect(roots.length).toBeGreaterThan(0);
    expect(roots).toContain('shared');
    expect(roots).toContain('design');
  });

  it('every value import from mobile lands in a folder Metro watches', () => {
    const watched = watchedRoots();
    for (const e of escapingImports()) {
      if (e.typeOnly) continue; // erased before Metro sees it
      expect(
        watched,
        `${e.file} imports '${e.spec}' as a VALUE, but Metro does not watch "${e.root}" — `
        + `add it to watchFolders in mobile/metro.config.js, or make the import type-only`,
      ).toContain(e.root);
    }
  });

  it('an import from an unwatched folder is type-only', () => {
    const watched = watchedRoots();
    for (const e of escapingImports()) {
      if (watched.includes(e.root)) continue;
      expect(
        e.typeOnly,
        `${e.file} imports '${e.spec}' from unwatched "${e.root}" without \`import type\``,
      ).toBe(true);
    }
  });

  it('the unwatched type-only target really is erasable', () => {
    // `import type` only erases if the module contributes nothing at runtime.
    // An enum or a const added here would be emitted and Metro would have to
    // resolve a path it does not watch.
    const src = readFileSync(join(ROOT, 'lib/database.types.ts'), 'utf8');
    expect(src).not.toMatch(/^export\s+(const|let|var|function|class|default|enum)\b/m);
    expect(src).not.toMatch(/^\s*enum\s+/m);
  });
});
