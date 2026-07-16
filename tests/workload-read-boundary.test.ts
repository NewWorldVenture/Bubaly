import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/workload/page.tsx', 'utf8');
const actions = fs.readFileSync('app/(app)/dashboard/workload/actions.ts', 'utf8');
const module = fs.readFileSync('components/modules/workload-module.tsx', 'utf8');

describe('workload read and persistence boundaries', () => {
  it('fails visibly when any required workload query fails', () => {
    expect(page).toContain('const failedQuery = queries.find((query) => query.error);');
    expect(page).toContain('Could not load workload data from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });

  it('does not present missing workload history as a roadmap state', () => {
    expect(actions).not.toContain('Workload history is not available yet.');
    expect(actions).toContain('Could not save workload history. Refresh and try again.');
    expect(module).toContain('if (!res.ok) toastError(res.error);');
  });
});
