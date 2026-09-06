import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/supabase-forward-release.yml', 'utf8');

describe('reviewed forward release read-only proof workflow', () => {
  it('exposes an explicit proof input without changing the default preview mode', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/require_applied:\s+description: [^\n]+\s+type: boolean\s+default: false/);
    expect(workflow).toMatch(/apply:\s+description: [^\n]+\s+type: boolean\s+default: false/);
    expect(workflow).toContain('REQUIRE_APPLIED: ${{ inputs.require_applied }}');
  });

  it('rejects mixed modes before selecting the read-only proof or the existing explicit apply path', () => {
    const reject = workflow.indexOf('if [ "$APPLY_RELEASE" = "true" ] && [ "$REQUIRE_APPLIED" = "true" ]; then');
    const proof = workflow.indexOf('node scripts/apply-production-forward-release.mjs --require-applied');
    const apply = workflow.indexOf('node scripts/apply-production-forward-release.mjs --apply');
    expect(reject).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(reject);
    expect(apply).toBeGreaterThan(proof);
    expect(workflow.slice(reject, proof)).toContain('exit 1');
    expect(workflow).toContain('elif [ "$APPLY_RELEASE" = "true" ]; then');
  });

  it('does not launch a follow-up database capture when proof mode is held or incomplete', () => {
    expect(workflow).toMatch(/name: Capture metadata after release attempt\s+if: always\(\) && !inputs\.require_applied/);
    expect(workflow).toContain('if: success() && (inputs.apply || inputs.require_applied)');
    expect(workflow).toContain('name: production-forward-release-audit');
  });

  it('retains production serialization and introduces no replay or backfill commands', () => {
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('group: supabase-production-migrations');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toMatch(/db push|--include-all|migration repair|backfill/i);
  });
});
