import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, allByName, click, has, nodes, render, settle, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Three defects on /dashboard/medical and /dashboard/dental (MedicalRecordsModule).
//
// S4 — 0438 lets a non-manager read only their own `medical_profiles` row, and
//   the Health Profiles section still drew a card per member: every other
//   member's read "No profile on file." A babysitter checking a child before a
//   meal concluded there were no allergies on record, when the profile existed
//   and was withheld. Unlike the insurance and provider sections, nothing said
//   the list was narrowed.
// S8 — deleting an insurance policy deleted the row and left both card photos
//   (member ID, group number, Rx BIN) in the documents bucket, behind a
//   confirmation that promised "the card photos go with it"; replacing a photo
//   and saving, or closing the form after picking one, left uploads behind too.
//   No documents row points at those objects, so nothing restricts them (0303).
// S10 — saving a profile upserted all thirteen columns from the snapshot the
//   form took when it opened. Realtime never refreshes an open form, so a
//   parent updating the pharmacy erased the allergy the other parent had just
//   added, and both were told "Profile saved".
//
// Each case drives the REAL module (tests/helpers/module-harness.tsx) against
// an in-memory database and a documents bucket that, like Supabase, answers a
// refused delete with `error: null` and an empty list.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/medical/print-sheet', () => ({ ProviderInfoSheet: () => null, CheckInSheet: () => null }));

const { MedicalRecordsModule } = await import('@/components/modules/medical-records-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

const PARENT = { id: 'member-parent', display_name: 'Ada', role: 'parent', user_id: 'user-1', is_active: true, color: null, birthday: null };
const CHILD = { id: 'member-child', display_name: 'Bo', role: 'child', user_id: 'user-child', is_active: true, color: null, birthday: null };
const SITTER = { id: 'member-sitter', display_name: 'Cy', role: 'caregiver', user_id: 'user-sitter', is_active: true, color: null, birthday: null };

function viewAs(self: typeof PARENT, role: string) {
  h.app.members = [PARENT, CHILD, SITTER];
  h.app.selfMember = self;
  h.app.userId = self.user_id;
  (h.app as Record<string, unknown>).role = role;
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  viewAs(PARENT, 'parent');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(MedicalRecordsModule, { kind: 'medical' }));
const bucket = () => [...(h.storage.objects.get('documents') ?? [])].sort();

/** The Health Profiles card for one member: the element holding their name and their profile line. */
function profileCard(tree: ReactNode, name: string): string {
  const cards = nodes(tree).filter((node) => node.type === 'div' && String(node.props.className ?? '').includes('rounded-xl border border-border p-4'));
  const card = cards.find((node) => text(node).startsWith(name));
  if (!card) throw new Error(`no profile card for ${name}`);
  return text(card);
}

const dialog = (tree: ReactNode, title: string): Node => {
  const found = nodes(tree).find((node) => node.props.role === 'dialog' && node.props['aria-label'] === title);
  if (!found) throw new Error(`no dialog titled ${title}`);
  return found;
};

async function pickCardPhoto(tree: ReactNode, side: 0 | 1, name: string) {
  const inputs = nodes(dialog(tree, t('medicalRecords.editInsurance'))).filter((node) => node.type === 'input' && node.props.type === 'file');
  (inputs[side].props.onChange as (event: unknown) => void)({ target: { files: [{ name, size: 2048, type: 'image/jpeg' }], value: '' } });
  await settle();
}

describe('S4 — a health profile a reader cannot see is not shown as missing', () => {
  it('a caregiver is told a child\'s profile is kept for parents and adults, not that there is none', async () => {
    viewAs(SITTER, 'caregiver');
    // 0438: the caregiver's session reads only the caregiver's own row.
    db.seed('medical_profiles', [{ id: 'mp-sitter', family_id: FAMILY, member_id: SITTER.id, allergies: 'Latex' }]);

    const tree = screen();

    expect(profileCard(tree, 'Bo')).not.toContain('No profile on file.');
    expect(profileCard(tree, 'Bo')).toContain(t('medicalRecordsModule.profileKeptForManagers'));
    expect(has(tree, t('medicalRecordsModule.onlyYourOwnProfile'))).toBe(true);
    // The reader's own card is theirs to read, and reads as it is.
    expect(profileCard(tree, 'Cy')).toContain('Latex');
  });

  it('a teen with no profile of their own is told so plainly', async () => {
    const TEEN = { ...CHILD, id: 'member-teen', display_name: 'Di', role: 'teen', user_id: 'user-teen' };
    h.app.members = [PARENT, TEEN];
    h.app.selfMember = TEEN;
    h.app.userId = TEEN.user_id;
    (h.app as Record<string, unknown>).role = 'teen';

    const tree = screen();

    expect(profileCard(tree, 'Di')).toContain('No profile on file.');
    expect(profileCard(tree, 'Ada')).toContain(t('medicalRecordsModule.profileKeptForManagers'));
  });

  it('a parent, who reads every profile, sees no narrowing note', async () => {
    const tree = screen();
    expect(has(tree, t('medicalRecordsModule.onlyYourOwnProfile'))).toBe(false);
    expect(has(tree, t('medicalRecordsModule.profileKeptForManagers'))).toBe(false);
  });
});

describe('S8 — an insurance card photo nothing points at leaves the bucket', () => {
  const front = `${FAMILY}/insurance/1700000000000-front.jpg`;
  const back = `${FAMILY}/insurance/1700000000001-back.jpg`;
  const policy = () => ({ id: 'pol-1', family_id: FAMILY, kind: 'medical', insurer: 'Blue Shield', is_primary: true, member_id: CHILD.id, front_image_path: front, back_image_path: back });

  it('deleting a policy deletes both card photos, as the confirmation promises', async () => {
    db.seed('insurance_policies', [policy()]);
    h.storage.objects.set('documents', new Set([front, back]));

    await click(allByName(screen(), t('a11y.delete'))[0]);

    expect(db.table('insurance_policies')).toEqual([]);
    expect(bucket()).toEqual([]);
    expect(h.toasts.success).toContain(t('medicalRecordsModule.deleted'));
  });

  it('says so when storage keeps a photo, instead of claiming a clean delete', async () => {
    db.seed('insurance_policies', [policy()]);
    h.storage.objects.set('documents', new Set([front, back]));
    h.storage.refused.add(back);

    await click(allByName(screen(), t('a11y.delete'))[0]);

    expect(db.table('insurance_policies')).toEqual([]);
    expect(bucket()).toEqual([back]);
    expect(h.toasts.error).toContain(t('medicalRecordsModule.deletedButCardPhotosKept'));
    expect(h.toasts.success).not.toContain(t('medicalRecordsModule.deleted'));
  });

  it('replacing the front photo and saving removes the old one and keeps the new one and the back', async () => {
    db.seed('insurance_policies', [policy()]);
    h.storage.objects.set('documents', new Set([front, back]));
    await click(allByName(screen(), t('a11y.edit'))[0]);
    await pickCardPhoto(screen(), 0, 'new-front.jpg');
    const uploaded = bucket().find((path) => path.endsWith('new-front.jpg'))!;
    expect(uploaded).toBeTruthy();

    await click(byName(dialog(screen(), t('medicalRecords.editInsurance')), t('medicalRecordsModule.saveChanges')));

    expect(db.table('insurance_policies')[0].front_image_path).toBe(uploaded);
    expect(bucket()).toEqual([back, uploaded].sort());
  });

  it('closing the form unsaved removes what it uploaded and leaves the saved photos alone', async () => {
    db.seed('insurance_policies', [policy()]);
    h.storage.objects.set('documents', new Set([front, back]));
    await click(allByName(screen(), t('a11y.edit'))[0]);
    await pickCardPhoto(screen(), 0, 'first-try.jpg');
    await pickCardPhoto(screen(), 0, 'second-try.jpg');
    expect(bucket()).toHaveLength(4);

    (dialog(screen(), t('medicalRecords.editInsurance')).props.onClose as () => void)();
    await settle();

    expect(bucket()).toEqual([back, front].sort());
    expect(db.table('insurance_policies')[0]).toMatchObject({ front_image_path: front, back_image_path: back });
  });
});

describe('S10 — saving a profile writes only what this person changed', () => {
  it('a pharmacy edit saved over a stale form keeps the allergy another parent added meanwhile', async () => {
    db.seed('medical_profiles', [{ id: 'mp-child', family_id: FAMILY, member_id: CHILD.id, allergies: null, preferred_pharmacy: 'Walgreens', updated_at: '2026-10-13T08:00:00Z' }]);
    // This parent opens Bo's profile on the laptop…
    const pencils = allByName(screen(), t('a11y.edit'));
    await click(pencils[1]);
    // …while the other parent adds the peanut allergy from a phone, and saves.
    Object.assign(db.table('medical_profiles')[0], { allergies: 'Peanuts', updated_at: '2026-10-13T08:05:00Z' });

    const form = dialog(screen(), t('medicalRecords.healthProfile'));
    const pharmacy = nodes(form).find((node) => node.type === 'input' && node.props.placeholder === t('medicalRecords.walgreensOakSt'))!;
    (pharmacy.props.onChange as (event: unknown) => void)({ target: { value: 'CVS on Main' } });
    await click(byName(dialog(screen(), t('medicalRecords.healthProfile')), t('medicalRecords.saveProfile')));

    expect(h.toasts.success).toContain(t('medicalRecordsModule.profileSaved'));
    expect(db.table('medical_profiles')).toHaveLength(1);
    expect(db.table('medical_profiles')[0]).toMatchObject({ preferred_pharmacy: 'CVS on Main', allergies: 'Peanuts' });
  });

  it('a first profile still saves what was typed into it', async () => {
    const pencils = allByName(screen(), t('a11y.edit'));
    await click(pencils[1]);
    const form = dialog(screen(), t('medicalRecords.healthProfile'));
    const allergies = nodes(form).find((node) => node.type === 'textarea' && node.props.placeholder === t('medicalRecords.penicillinPeanuts'))!;
    (allergies.props.onChange as (event: unknown) => void)({ target: { value: 'Penicillin' } });
    await click(byName(dialog(screen(), t('medicalRecords.healthProfile')), t('medicalRecords.saveProfile')));

    expect(db.table('medical_profiles')).toHaveLength(1);
    expect(db.table('medical_profiles')[0]).toMatchObject({ member_id: CHILD.id, family_id: FAMILY, allergies: 'Penicillin' });
  });
});
