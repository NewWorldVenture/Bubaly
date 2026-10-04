import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { createOwnedAccount, type OwnedAccount } from './helpers/durable-session';
import { familyPhotoRowCount, observeFamilyPhotoUpload } from './helpers/family-photo-diagnostics';

// SEC-001, end to end on the disposable Supabase this job starts, with every
// migration applied (0459 among them, so `family-media` is private here).
//
// A parent uploads a photo through the real Photos page. The page must show
// it, through a URL signed with the parent's own session. The URL the row
// stores, which was the photo's only credential while the bucket was public,
// must now answer nothing to a request without one, and a parent of another
// family must not be able to sign the object either. If 0459 were missing,
// or a reader still rendered the stored URL, this spec is where it shows.

const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

// A real 1×1 PNG, so a loaded <img> has a natural width.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

test.describe('a family photo in a private bucket', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the isolated Supabase.');

  test('shows to its family through a signed URL, and to nobody through the stored one', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const admin = createClient(provider, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const bucket = await admin.storage.getBucket('family-media');
    expect(bucket.error, 'the family-media bucket exists').toBeNull();
    expect(bucket.data?.public, 'family-media is private (0459)').toBe(false);

    let owner: OwnedAccount | null = null;
    let stranger: OwnedAccount | null = null;
    const stored: string[] = [];
    let diagnostics: ReturnType<typeof observeFamilyPhotoUpload> | undefined;
    try {
      owner = await createOwnedAccount(provider, serviceKey);
      stranger = await createOwnedAccount(provider, serviceKey);

      await page.goto('/login?redirect=/dashboard/photos', { waitUntil: 'domcontentloaded' });
      await page.locator('input[name="email"]').fill(owner.email);
      await page.locator('input[name="password"]').fill(owner.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(`${baseURL}/dashboard/photos`, { timeout: 60_000 });

      await page.getByRole('button', { name: 'Upload', exact: true }).click();
      await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles({ name: 'sec001.png', mimeType: 'image/png', buffer: PIXEL });
      diagnostics = observeFamilyPhotoUpload(page, provider, record => {
        console.log('[family-photo-diagnostics]', JSON.stringify(record));
      });
      diagnostics.report('upload-click-start');
      await page.getByRole('button', { name: 'Upload 1 file', exact: true }).click();
      diagnostics.report('upload-click-complete');

      // The row the upload wrote, and the reference it stores.
      await expect.poll(async () => {
        const result = await diagnostics!.read(() => admin.from('family_photos').select('storage_path').eq('family_id', owner!.familyId));
        return familyPhotoRowCount(result);
      }, { timeout: 60_000 }).toBe(1);
      diagnostics.report('persistence-confirmed');
      const result = await diagnostics.read(() => admin.from('family_photos').select('url, storage_path').eq('family_id', owner!.familyId));
      expect(familyPhotoRowCount(result), 'the photo reference read succeeds with one row').toBe(1);
      const rows = result.data;
      const row = rows![0] as { url: string; storage_path: string };
      expect(typeof row?.url === 'string' && typeof row?.storage_path === 'string', 'the photo reference has the required fields').toBe(true);
      diagnostics.report('row-read-complete');
      stored.push(row.storage_path);
      expect(row.storage_path.startsWith(`${owner.familyId}/photos/`)).toBe(true);

      // 1. The family sees it, through a signature, and never through the
      //    stored URL. The page opens on Albums; an upload outside an album
      //    is listed under All Photos.
      await page.getByRole('button', { name: 'All Photos', exact: true }).click();
      const shown = page.locator('img[src*="/object/sign/family-media/"]').first();
      await expect(shown).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 }).toBe(1);
      expect(await page.locator('img[src*="/object/public/family-media/"]').count(), 'no page renders a stored public URL').toBe(0);

      // 2. The stored URL answers nothing to a request without a session.
      const direct = await fetch(row.url);
      expect(direct.status, 'the stored reference refuses a request with no session').toBe(400);

      // 3. A parent of another family cannot sign it.
      const other = createClient(provider, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const signIn = await other.auth.signInWithPassword({ email: stranger.email, password: stranger.password });
      expect(signIn.error).toBeNull();
      const signed = await other.storage.from('family-media').createSignedUrl(row.storage_path, 60);
      expect(signed.data?.signedUrl ?? null, 'another family was given a signed URL for this photo').toBeNull();
      expect(signed.error).not.toBeNull();
      diagnostics.report('body-complete');
    } catch (error) {
      diagnostics?.report('body-failed');
      throw error;
    } finally {
      diagnostics?.dispose();
      if (stored.length) await admin.storage.from('family-media').remove(stored);
      if (owner) await admin.from('family_photos').delete().eq('family_id', owner.familyId);
      await owner?.dispose();
      await stranger?.dispose();
    }
  });
});
