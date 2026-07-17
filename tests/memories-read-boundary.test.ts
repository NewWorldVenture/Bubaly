import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/memories/page.tsx', 'utf8');

// PLA-0775: the Memories page must fail closed on its content-spine reads
// (family_albums + family_photos). A dropped error would render "your family
// memory lane is empty" for a family with hundreds of photos — a
// confidently-wrong empty state that invites duplicate re-uploads. The stat
// counts and the members/upcoming enrichment reads stay best-effort, and a
// genuinely missing table (unapplied migration) is still tolerated as empty.
describe('memories page read boundary', () => {
  it('captures the album + photo read results with a missing-table filter', () => {
    expect(page).toContain('const contentError = [albumsRes.error, photosRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a content read failure', () => {
    expect(page).toContain('if (contentError) {');
    expect(page).toContain("console.error('[dashboard/memories] memories read failed', contentError);");
    expect(page).toContain('return <ErrorState message="Could not load your memories from Supabase. Refresh and try again." />;');
  });

  it('derives albums/photos only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (contentError) {');
    const albumsIdx = page.indexOf('const albums = (albumsRes.data ?? [])');
    const photosIdx = page.indexOf('const photos = (photosRes.data ?? [])');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(albumsIdx).toBeGreaterThan(guardIdx);
    expect(photosIdx).toBeGreaterThan(guardIdx);
  });
});
