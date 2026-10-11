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
let child: { userId: string; email: string; password: string; memberId: string } | null = null;

const admin = () => createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** A JPEG-signed buffer of `bytes` length: Storage and the action read its type, not its pixels. */
function photo(bytes: number): Buffer {
  const b = Buffer.alloc(bytes, 0x20);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], bytes - 2);
  return b;
}

async function signIn(page: Page, to: string, who: { email: string; password: string } = account!) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(who.email);
  await page.locator('input[name="password"]').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

/** A child member of the fixture household, with their own sign-in. */
async function addChild() {
  const db = admin();
  const email = `chore-proof-child-${crypto.randomUUID()}@example.test`;
  const password = `Ck1!${crypto.randomUUID()}`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Proof Child' } });
  if (created.error || !created.data.user) throw new Error('Chore proof E2E could not create its child account.');
  const userId = created.data.user.id;
  child = { userId, email, password, memberId: '' };
  const member = await db.from('family_members').insert({
    family_id: account!.familyId, user_id: userId, role: 'child', display_name: 'Proof Child', is_active: true,
  }).select('id').single();
  if (member.error || !member.data) throw new Error(`Chore proof E2E could not add its child (${member.error?.code ?? 'no row'}).`);
  const prefs = await db.from('user_preferences').upsert({
    user_id: userId, active_family_id: account!.familyId, notification_prefs: { onboardingComplete: true },
  }, { onConflict: 'user_id' });
  if (prefs.error) throw new Error('Chore proof E2E could not set the child household.');
  child.memberId = member.data.id;
  return child;
}

async function assignTo(member: string) {
  const db = admin();
  const chore = await db.from('chores').insert({ family_id: account!.familyId, title: 'Tidy your room', proof_required: 'photo' }).select('id').single();
  if (chore.error || !chore.data) throw new Error('Chore proof E2E could not create the child chore.');
  const assignment = await db.from('chore_assignments').insert({ family_id: account!.familyId, chore_id: chore.data.id, member_id: member }).select('id').single();
  if (assignment.error || !assignment.data) throw new Error('Chore proof E2E could not assign the child chore.');
  return assignment.data.id;
}

async function storedProof(member = memberId) {
  const { data, error } = await admin().storage.from('chore-proof').list(`${account!.familyId}/${member}`);
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
      for (const member of [memberId, child?.memberId].filter(Boolean) as string[]) {
        const objects = account ? await storedProof(member) : [];
        if (objects.length) await admin().storage.from('chore-proof').remove(objects.map((o) => `${account!.familyId}/${member}/${o.name}`));
      }
      if (child) await admin().auth.admin.deleteUser(child.userId);
      await account?.dispose();
    } finally { account = null; child = null; }
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

  test('a child signed in as themselves uploads into their own folder and submits', async ({ page }) => {
    // The parent test above proves the path a manager takes; this is the
    // child's own session, through 0376's own-folder write policy.
    const kid = await addChild();
    const childAssignment = await assignTo(kid.memberId);
    const to = `/kids/submit/${childAssignment}`;
    await signIn(page, to, kid);
    await page.locator('input[type="file"][name="media"]').setInputFiles({ name: 'room.jpg', mimeType: 'image/jpeg', buffer: photo(2 * 1024 * 1024) });
    await page.getByRole('button', { name: 'Submit my work' }).click();

    await expect(page.getByText('Sent! 🎉')).toBeVisible({ timeout: 60_000 });
    const objects = await storedProof(kid.memberId);
    expect(objects).toHaveLength(1);
    const path = `${account!.familyId}/${kid.memberId}/${objects[0].name}`;
    const { data } = await admin().from('chore_submissions').select('media_paths, member_id, created_by').eq('assignment_id', childAssignment);
    expect(data).toEqual([{ media_paths: [path], member_id: kid.memberId, created_by: kid.userId }]);
    expect(await storedProof(memberId), 'nothing written to the parent folder').toEqual([]);
  });

  /**
   * Holds the form's upload to Storage until `go()`, so the attempt is under
   * way when the child leaves; for a video the upload is the long part.
   * `answer` resolves with the action's response, wherever it was posted.
   */
  async function holdUpload(page: Page) {
    let go!: () => void;
    const gate = new Promise<void>((resolve) => { go = resolve; });
    let reached = false;
    await page.route('**/storage/v1/object/chore-proof/**', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      reached = true;
      await gate;
      await route.continue();
    });
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']), { timeout: 60_000 });
    return { go, answer, reached: () => reached };
  }

  /**
   * Leaves the submit page by the app's own navigation while the attempt is
   * held, then lets the attempt go. The navigation is a transition, and React
   * commits it together with the form's own pending one, so the page changes
   * when the attempt has answered — the moment the form used to arm its 2.2 s
   * redirect to /kids — and the form unmounts in that commit.
   */
  async function leaveForDashboard(page: Page, go: () => void) {
    await page.locator('a[href="/dashboard"]').first().click();
    go();
    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 60_000 });
  }

  test('leaving mid-attempt: the proof is still recorded, and the late answer neither shows nor sends the child back', async ({ page }) => {
    await signIn(page, `/kids/submit/${assignmentId}`);
    await page.locator('input[type="file"][name="media"]').setInputFiles({ name: 'bed.jpg', mimeType: 'image/jpeg', buffer: photo(256 * 1024) });
    const upload = await holdUpload(page);
    await page.getByRole('button', { name: 'Submit my work' }).click();
    await expect.poll(upload.reached, { timeout: 30_000 }).toBe(true);
    await leaveForDashboard(page, upload.go);
    expect((await upload.answer).status()).toBe(200);
    // Past the 2.2 s the form waits before sending a child to /kids.
    await page.waitForTimeout(3_500);
    expect(new URL(page.url()).pathname, 'the late success did not navigate').toBe('/dashboard');
    await expect(page.getByText('Sent! 🎉')).toHaveCount(0);
    // The attempt completed without the form: the submission and its proof.
    const objects = await storedProof();
    expect(objects).toHaveLength(1);
    const { data } = await admin().from('chore_submissions').select('media_paths').eq('assignment_id', assignmentId);
    expect(data).toEqual([{ media_paths: [`${account!.familyId}/${memberId}/${objects[0].name}`] }]);
  });

  test('leaving mid-attempt, which the action then refuses: the attempt still releases its upload, and the page shows nothing of it', async ({ page }) => {
    await signIn(page, `/kids/submit/${assignmentId}`);
    await page.locator('input[type="file"][name="media"]').setInputFiles({ name: 'bed.jpg', mimeType: 'image/jpeg', buffer: photo(256 * 1024) });
    const upload = await holdUpload(page);
    await page.getByRole('button', { name: 'Submit my work' }).click();
    await expect.poll(upload.reached, { timeout: 30_000 }).toBe(true);
    // The chore goes away before the action runs, so the action refuses it.
    const removed = await admin().from('chore_assignments').delete().eq('id', assignmentId);
    expect(removed.error).toBeNull();
    await leaveForDashboard(page, upload.go);
    expect((await upload.answer).status()).toBe(200);
    await expect.poll(async () => (await storedProof()).length, { timeout: 15_000, message: 'the refused attempt released its upload' }).toBe(0);
    await page.waitForTimeout(1_000);
    expect(new URL(page.url()).pathname).toBe('/dashboard');
    await expect(page.getByText('Chore not found.')).toHaveCount(0);
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
