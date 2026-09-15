import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The suite's result used to depend on which Node patch a machine happened to
// have. A runtime-sensitive test (stream cancellation, since removed) passed on
// the CI runner and failed on 22.22.2, because `node-version: 22` lets the
// runner drift anywhere within 22.x independently of contributors, and there was
// no `engines` field and no .nvmrc to disagree with.
//
// A green suite that means different things on different machines is a weaker
// claim than it looks. One file now decides the version for CI, nvm and npm.

const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines?: { node?: string } };
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('the Node version is decided in one place', () => {
  it('.nvmrc names an exact version, not a floating major', () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('package.json engines agrees with .nvmrc and bounds the major', () => {
    const range = pkg.engines?.node;
    expect(range, 'package.json has no engines.node').toBeTruthy();
    expect(range).toContain(nvmrc);
    // An open-ended range would let Node 23 in without anyone deciding to.
    expect(range).toMatch(/<\s*\d+/);
  });

  it('every CI job reads that file rather than repeating a version', () => {
    // Comment lines are excluded: the workflow explains the old `node-version: 22`
    // it replaced, and a naive scan matches its own rationale.
    const directives = ci.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(directives).not.toMatch(/node-version:\s*\d/);
    const uses = ci.match(/actions\/setup-node@/g) ?? [];
    const reads = ci.match(/node-version-file: \.nvmrc/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(reads.length, 'a setup-node step does not read .nvmrc').toBe(uses.length);
  });

  it('the running Node satisfies what the repository declares', () => {
    // If this fails locally, the machine is not running what CI runs — which is
    // the whole condition this file exists to make visible.
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    const [wantMajor, wantMinor, wantPatch] = nvmrc.split('.').map(Number);
    const actual = major * 1e6 + minor * 1e3 + patch;
    const wanted = wantMajor * 1e6 + wantMinor * 1e3 + wantPatch;
    expect(actual, `running Node ${process.versions.node}, repository declares ${nvmrc}`)
      .toBeGreaterThanOrEqual(wanted);
    expect(major).toBe(wantMajor);
  });
});
