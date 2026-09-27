// m14 · Dashboard → Contact Center → "Family phone number" → Get a number.
//
// provisionFamilyNumber used the channel row it read only for `channel.error`:
// the number already on it was never looked at, so every call searched and
// BOUGHT, then overwrote phone_number/phone_number_sid with the new pair. Two
// things followed, and both are losses a family or an operator lives with:
//
//   * the number the family gave the school, the pediatrician and the plumber
//     stopped resolving (resolveFamilyByNumberResult), while Twilio still owned
//     it and still posted to our webhooks — so a caller heard "This number is
//     not in service" and a text to it was dropped without reaching the inbox;
//   * the old SID was overwritten and is read nowhere, so an orphaned number
//     kept billing with nothing in the product able to name it.
//
// The reachable repeats were not only a bored double-click: the two failure
// branches bought a number WITHOUT persisting it, left the button on screen and
// invited the next click.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { provisionFamilyNumber, resolveFamilyByNumber } from '@/lib/contact-center/server';

const mocks = vi.hoisted(() => ({ configured: vi.fn(), search: vi.fn(), buy: vi.fn(), findOwned: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: mocks.configured,
  searchAvailableNumber: mocks.search,
  provisionNumber: mocks.buy,
  findOwnedNumberSid: mocks.findOwned,
  releaseNumber: mocks.release,
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PUBLISHED = '+15125550999';           // what is written on the fridge
const PUBLISHED_SID = `PN${'a'.repeat(32)}`;
const CANDIDATE = '+15125550111';           // what a fresh search would offer
const BOUGHT_SID = `PN${'b'.repeat(32)}`;
const WINNER = '+15125550222';              // what the other parent's click got
const WINNER_SID = `PN${'c'.repeat(32)}`;
const writeFailure = { data: null, error: { code: '08006', message: 'synthetic write failure', details: null, hint: null }, count: null, status: 503, statusText: 'Service Unavailable' };
let db: ReturnType<typeof createInMemorySupabase>;

const provision = (areaCode?: string) => provisionFamilyNumber(db as never, FAMILY, areaCode);
const channelRow = () => db.table('family_contact_channels')[0];
/** Who a call to that number reaches — the webhooks' only routing question. */
const reaches = (number: string) => resolveFamilyByNumber(db as never, number);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://contact.example');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = createInMemorySupabase({ uniques: { family_contact_channels: [['family_id'], ['phone_number']] } });
  db.seed('families', [{ id: FAMILY, name: 'Synthetic family' }]);
  mocks.configured.mockReturnValue(true);
  mocks.search.mockResolvedValue(CANDIDATE);
  mocks.buy.mockResolvedValue({ phoneNumber: CANDIDATE, sid: BOUGHT_SID });
  mocks.findOwned.mockResolvedValue(null);
  mocks.release.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('a family that already has its dedicated number', () => {
  beforeEach(() => {
    db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: PUBLISHED, phone_number_sid: PUBLISHED_SID, provisioning_status: 'active' }]);
  });

  it('keeps the number the school calls when provisioning is asked for again', async () => {
    expect(await provision()).toEqual({ ok: true, phoneNumber: PUBLISHED });
    expect(await reaches(PUBLISHED)).toBe(FAMILY);
    expect(channelRow()).toMatchObject({ phone_number: PUBLISHED, phone_number_sid: PUBLISHED_SID, provisioning_status: 'active' });
  });

  it('spends nothing to answer that, so no second number is bought or stranded', async () => {
    await provision('512');
    await provision('512');
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('a family with no number yet', () => {
  beforeEach(() => {
    db.seed('family_contact_channels', [{ family_id: FAMILY, phone_number: null, phone_number_sid: null, provisioning_status: 'unprovisioned' }]);
  });

  it('gets one, and calls to it reach them', async () => {
    expect(await provision('512')).toEqual({ ok: true, phoneNumber: CANDIDATE });
    expect(mocks.buy).toHaveBeenCalledOnce();
    expect(await reaches(CANDIDATE)).toBe(FAMILY);
    expect(channelRow()).toMatchObject({ phone_number: CANDIDATE, phone_number_sid: BOUGHT_SID, provisioning_status: 'active' });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('hands a purchase back when it cannot be saved, rather than leaving it billing', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      // Every write to the channel row fails; the reads still answer.
      if (table === 'family_contact_channels') query.then = ((f, r) => Promise.resolve(writeFailure).then(f, r)) as typeof query.then;
      return query;
    }) as typeof db.from);

    expect(await provision()).toEqual({ ok: false, skipped: false, error: 'The number could not be saved. Please try again.' });
    expect(mocks.release).toHaveBeenCalledWith(BOUGHT_SID);
    vi.mocked(db.from).mockRestore();
    expect(channelRow().phone_number ?? null).toBeNull();
    expect(await reaches(CANDIDATE)).toBeNull();
  });

  it('names an unconfirmed release so an operator can reconcile it instead of paying for it', async () => {
    mocks.release.mockResolvedValue(false);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const query = from(table);
      if (table === 'family_contact_channels') query.then = ((f, r) => Promise.resolve(writeFailure).then(f, r)) as typeof query.then;
      return query;
    }) as typeof db.from);

    await provision();
    expect(console.error).toHaveBeenCalledWith(
      '[contact-center] a provisioned number was not saved and could not be released',
      { sid: BOUGHT_SID, phoneNumber: CANDIDATE },
    );
  });

  it('reconciles a purchase whose response never came back, so it stops answering our webhooks', async () => {
    mocks.buy.mockRejectedValue(new DOMException('synthetic provider timeout', 'TimeoutError'));
    mocks.findOwned.mockResolvedValue(BOUGHT_SID); // Twilio did create it before the deadline

    expect(await provision()).toEqual({ ok: false, skipped: false, error: 'Could not provision a number. Please try again.' });
    expect(mocks.findOwned).toHaveBeenCalledWith(CANDIDATE);
    expect(mocks.release).toHaveBeenCalledWith(BOUGHT_SID);
    expect(channelRow()).toMatchObject({ provisioning_status: 'failed', phone_number: null });
  });

  it('leaves one number, not two, when both parents press the button at once', async () => {
    // The other parent's call commits between our purchase and our write.
    mocks.buy.mockImplementation(async () => {
      Object.assign(channelRow(), { phone_number: WINNER, phone_number_sid: WINNER_SID, provisioning_status: 'active' });
      return { phoneNumber: CANDIDATE, sid: BOUGHT_SID };
    });

    expect(await provision()).toEqual({ ok: true, phoneNumber: WINNER });
    expect(channelRow()).toMatchObject({ phone_number: WINNER, phone_number_sid: WINNER_SID });
    expect(mocks.release).toHaveBeenCalledWith(BOUGHT_SID);
    expect(await reaches(WINNER)).toBe(FAMILY);
    expect(await reaches(CANDIDATE)).toBeNull();
  });

  it('only records the request when telephony is not configured, and buys nothing', async () => {
    mocks.configured.mockReturnValue(false);
    expect(await provision()).toEqual({ ok: false, skipped: true });
    expect(channelRow().provisioning_status).toBe('pending');
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('buys nothing when the area code has nothing available', async () => {
    mocks.search.mockResolvedValue(null);
    expect(await provision('512')).toEqual({ ok: false, skipped: false, error: 'No numbers available for that area code.' });
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
