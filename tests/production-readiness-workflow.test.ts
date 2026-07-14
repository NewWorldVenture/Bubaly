import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('production readiness CI gates', () => {
  it('runs the dependency audit in the quality job', () => {
    expect(workflow).toContain('npm audit --omit=dev --audit-level=moderate');
  });

  it('checks both Auth and schema capabilities against isolated Supabase', () => {
    expect(workflow).toContain('run: npm run db:audit:auth');
    expect(workflow).toContain('run: npm run db:audit:schema');
  });
});
