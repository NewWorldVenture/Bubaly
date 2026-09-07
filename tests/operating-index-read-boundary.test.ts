import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const server = fs.readFileSync('lib/operating-index/server.ts', 'utf8');
const context = fs.readFileSync('lib/reasoning/context.ts', 'utf8');
const page = fs.readFileSync('app/(app)/dashboard/family-operating-index/page.tsx', 'utf8');

describe('Operating Index and reasoning read boundaries', () => {
  it('preserves input, graph, and route failures instead of converting them to empty data', () => {
    expect(server).toContain('const readError = [');
    expect(server).toContain('membersRes.error');
    expect(server).toContain('const readError = [tomorrowRes.error, autoRes.error, approvalsRes.error, missingRes.error]');
    expect(server).toContain('if (recentError)');
    expect(context).toContain('const readError = ents.error ?? edges.error;');
    expect(context).toContain('throw readError;');
    expectSays(page, 'familyOperatingIndex.couldNotLoadYourFamily', 'Could not load your family operating index from Supabase. Refresh and try again.');
    expect(page).toContain('loadFamilyGraph(supabase, ctx.active.familyId)');
  });
});
