import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';

// A child's proof photo, through the real submit page, to a stored submission.
//
// The form used to put the photo in the server action's body. Next caps a
// server action's body at 1 MB unless next.config raises it, and this app does
// not, so an ordinary phone photo was refused with a 413 before the action ran,
// whatever the action itself allowed (50 MB). The form now uploads straight to
// the member's own `chore-proof` folder and sends the action only the path.
//
// Real pages and Storage on the disposable local stack, a disposable household,
// synthetic bytes. Any request to a host other than this machine is aborted and
// reported; with no AI key configured the reviewer falls back to parent review.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off' });

let account: OwnedAccount | null = null;
let external: string[] = [];
let assignmentId = '';
let memberId = '';

const admin = () => createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** A JPEG-signed buffer of `bytes` length: Storage and the action read its type, not its pixels. */
function photo(bytes: number): Buffer {
  const b = Buffer.alloc(bytes, 0x20);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], bytes - 2);
  return b;
}

async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(account!.email);
  await page.locator('input[name="password"]').fill(account!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

async function storedProof() {
  const { data, error } = await admin().storage.from('chore-proof').list(`${account!.familyId}/${memberId}`);
  if (error) throw new Error(`could not list proof objects (${error.message})`);
  return data ?? [];
}

test.describe('chore proof: a phone-sized photo reaches a stored submission', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');
  // Sign-in, a 3 MB upload and the review fallback; the default 30 s is for a page, not this.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ context }) => {
    external = [];
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      external.push(hostname);
      return route.abort();
    });
    account = await createOwnedAccount(requireLocalOrigin(provider), serviceKey);
    const db = admin();
    const member = await db.from('family_members').select('id').eq('family_id', account.familyId).eq('user_id', account.userId).single();
    if (member.error || !member.data) throw new Error('Chore proof E2E could not read its own membership.');
    memberId = member.data.id;
    const chore = await db.from('chores').insert({ family_id: account.familyId, title: 'Make the bed', proof_required: 'photo' }).select('id').single();
    if (chore.error || !chore.data) throw new Error(`Chore proof E2E could not create its chore (${chore.error?.code ?? 'no row'}).`);
    const assignment = await db.from('chore_assignments')
      .insert({ family_id: account.familyId, chore_id: chore.data.id, member_id: memberId }).select('id').single();
    if (assignment.error || !assignment.data) throw new Error(`Chore proof E2E could not assign its chore (${assignment.error?.code ?? 'no row'}).`);
    assignmentId = assignment.data.id;
  });

  test.afterEach(async () => {
    try {
      const objects = account ? await storedProof() : [];
      if (objects.length) await admin().storage.from('chore-proof').remove(objects.map((o) => `${account!.familyId}/${memberId}/${o.name}`));
      await account?.dispose();
    } finally { account = null; }
    expect(external, 'requests that left this machine').toEqual([]);
  });

  test('a 3 MB photo is uploaded, submitted and stored', async ({ page }) => {
    const to = `/kids/submit/${assignmentId}`;
    await signIn(page, to);
    await page.locator('input[type="file"][name="media"]').setInputFiles({ name: 'bed.jpg', mimeType: 'image/jpeg', buffer: photo(3 * 1024 * 1024) });
    const actionStatuses: number[] = [];
    page.on('response', (r) => { if (r.request().method() === 'POST' && new URL(r.url()).pathname === to) actionStatuses.push(r.status()); });
    await page.getByRole('button', { name: 'Submit my work' }).click();

    await expect(page.getByText('Sent! 🎉')).toBeVisible({ timeout: 60_000 });
    expect(actionStatuses, 'the server action answered, and not with 413').toEqual([200]);

    const objects = await storedProof();
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ metadata: expect.objectContaining({ mimetype: 'image/jpeg', size: 3 * 1024 * 1024 }) });
    const path = `${account!.familyId}/${memberId}/${objects[0].name}`;
    const { data: submissions, error } = await admin().from('chore_submissions').select('media_paths, kind, status, member_id').eq('assignment_id', assignmentId);
    expect(error).toBeNull();
    expect(submissions).toEqual([{ media_paths: [path], kind: 'photo', status: expect.any(String), member_id: memberId }]);
  });

  test('a file that is not a photo or video is refused before anything is uploaded', async ({ page }) => {
    await signIn(page, `/kids/submit/${assignmentId}`);
    await page.locator('input[type="file"][name="media"]').setInputFiles({
      name: 'bed.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    await page.getByRole('button', { name: 'Submit my work' }).click();

    await expect(page.getByText("That file isn't a photo or video we can use. Try another one.")).toBeVisible();
    expect(await storedProof()).toEqual([]);
    const { data } = await admin().from('chore_submissions').select('id').eq('assignment_id', assignmentId);
    expect(data).toEqual([]);
  });
});
