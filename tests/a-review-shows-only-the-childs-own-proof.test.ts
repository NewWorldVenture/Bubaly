import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// SEC-002. The parent approval queue signed whatever `media_paths` a
// submission row held. submitProofAction only accepts paths in the
// submitting child's own folder (isProofPathFor), but a child holds a real
// session, and chore_submissions takes a child's INSERT for their own
// assignment with no check on `media_paths` (0375, 0481 bind the row to the
// assignment, 0222 its status). The parent can read every member's proof, so
// a pending row of Ari's naming Bo's `<family>/<bo>/<uuid>-bed.jpg` was
// signed with the parent's session and shown on Ari's card as Ari's proof —
// a sibling's made bed, approved and paid as Ari's.
//
// This drives the page itself and reads the items it hands each ReviewCard.

const FAMILY = '11111111-1111-4111-8111-111111111111';
const ARI = '22222222-2222-4222-8222-222222222222';
const BO = '33333333-3333-4333-8333-333333333333';
const ARI_PHOTO = `${FAMILY}/${ARI}/44444444-4444-4444-8444-444444444444-room.jpg`;
const BO_PHOTO = `${FAMILY}/${BO}/55555555-5555-4555-8555-555555555555-bed.jpg`;
const OTHER_FAMILY_PHOTO = `66666666-6666-4666-8666-666666666666/${ARI}/77777777-7777-4777-8777-777777777777-bed.jpg`;

const requireFeature = vi.fn();
const createServer = vi.fn();
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: (key: string) => requireFeature(key) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/app/(app)/missions/review-card', () => ({ ReviewCard: () => null }));
vi.mock('@/components/ui/card', () => ({ Card: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/states', () => ({ EmptyState: () => null, ErrorState: () => null }));

type Item = { submissionId: string; mediaUrls: string[]; proofUnavailable: boolean };

function items(node: ReactNode, out: Item[] = []): Item[] {
  if (Array.isArray(node)) { for (const child of node) items(child, out); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<{ item?: Item; children?: ReactNode }>;
  if (el.props.item) out.push(el.props.item);
  items(el.props.children, out);
  return out;
}

let signed: string[][];

function client() {
  const db = createInMemorySupabase();
  db.seed('chore_submissions', [
    { id: 'sub-ari', family_id: FAMILY, assignment_id: 'asg-ari', chore_id: 'chore-bed', member_id: ARI, kind: 'photo', status: 'pending', media_paths: [ARI_PHOTO, BO_PHOTO, OTHER_FAMILY_PHOTO], note: null, created_at: '2026-10-20T10:00:00Z' },
    { id: 'sub-bo', family_id: FAMILY, assignment_id: 'asg-bo', chore_id: 'chore-bed', member_id: BO, kind: 'photo', status: 'pending', media_paths: [BO_PHOTO], note: null, created_at: '2026-10-20T09:00:00Z' },
  ]);
  db.seed('chores', [{ id: 'chore-bed', family_id: FAMILY, title: 'Make your bed', reward_mode: 'fixed_points', points: 10 }]);
  db.seed('family_members', [
    { id: ARI, family_id: FAMILY, display_name: 'Ari', color: null },
    { id: BO, family_id: FAMILY, display_name: 'Bo', color: null },
  ]);
  db.seed('chore_ai_validations', []);
  db.seed('chore_disputes', []);
  return {
    from: (table: string) => db.from(table),
    storage: {
      from: (bucket: string) => ({
        // The parent may read every folder of the family's proof, and Storage
        // signs whatever it may read: what is SHOWN is the page's decision.
        createSignedUrls: async (paths: string[]) => {
          signed.push(paths);
          return {
            data: paths.map((path) => ({ path, signedUrl: path.startsWith(`${FAMILY}/`) ? `https://signed.invalid/${bucket}/${path}` : null, error: path.startsWith(`${FAMILY}/`) ? null : 'Object not found' })),
            error: null,
          };
        },
      }),
    },
  };
}

async function render(): Promise<Map<string, Item>> {
  createServer.mockResolvedValue(client());
  const { default: MissionsPage } = await import('@/app/(app)/missions/page');
  return new Map(items(await MissionsPage()).map((item) => [item.submissionId, item]));
}

beforeEach(() => {
  signed = [];
  requireFeature.mockResolvedValue({
    active: { familyId: FAMILY, role: 'parent', member: { id: 'mem-parent' } },
    user: { id: 'user-parent' },
  });
});

describe('the approval queue shows a submission only the proof in its own child\'s folder', () => {
  it('a sibling\'s photo named by another child\'s submission is not shown as that child\'s proof', async () => {
    const byId = await render();
    const ari = byId.get('sub-ari');
    expect(ari).toBeDefined();
    expect(ari!.mediaUrls).toEqual([`https://signed.invalid/chore-proof/${ARI_PHOTO}`]);
    expect(ari!.mediaUrls.some((url) => url.includes(BO))).toBe(false);
    // And the parent is told proof is missing, rather than seeing a short set.
    expect(ari!.proofUnavailable).toBe(true);
  });

  it('the sibling\'s own submission still shows that photo', async () => {
    const byId = await render();
    expect(byId.get('sub-bo')!.mediaUrls).toEqual([`https://signed.invalid/chore-proof/${BO_PHOTO}`]);
    expect(byId.get('sub-bo')!.proofUnavailable).toBe(false);
  });

  it('no path outside the family is ever sent to be signed', async () => {
    await render();
    expect(signed.flat()).not.toContain(OTHER_FAMILY_PHOTO);
    expect(signed.flat().every((path) => path.startsWith(`${FAMILY}/`))).toBe(true);
  });
});

describe('isMemberProofPath', () => {
  it('is one object directly in that member\'s folder of that family, and nothing else', async () => {
    const { isMemberProofPath } = await import('@/lib/chores/proof-media');
    expect(isMemberProofPath(ARI_PHOTO, FAMILY, ARI)).toBe(true);
    // A name stored before proofFileName collapsed dots is still the child's.
    expect(isMemberProofPath(`${FAMILY}/${ARI}/44444444-4444-4444-8444-444444444444-bed..jpg`, FAMILY, ARI)).toBe(true);
    expect(isMemberProofPath(BO_PHOTO, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(OTHER_FAMILY_PHOTO, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(`${FAMILY}/${ARI}/../${BO}/x.jpg`, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(`${FAMILY}/${ARI}/..`, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(`${FAMILY}/${ARI}/`, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(`${FAMILY}/${ARI}/sub/x.jpg`, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(null, FAMILY, ARI)).toBe(false);
    expect(isMemberProofPath(ARI_PHOTO, FAMILY, '')).toBe(false);
  });
});
