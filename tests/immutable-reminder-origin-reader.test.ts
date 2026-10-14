import { describe, expect, it } from 'vitest';
import { readReminderCards, reminderCardsReader, reminderVisibleTo, visibleReminders, readVisibleReminders, type ReminderLink } from '@/lib/autopilot/reminder-cards';

type Row = Record<string, unknown>;
type PageLog = { table: string; columns: string; from: number; to: number; filters: Record<string, unknown> };
const family = 'synthetic-family';
const named = { role: 'teen', memberId: 'named-member' };
const other = { role: 'teen', memberId: 'other-member' };
const manager = { role: 'parent', memberId: 'manager-member' };
const origin = (id: string, generated = true, cardId: string | null = 'card'): Row => ({ id, family_id: family, autopilot_origin: generated, autopilot_card_id: cardId });
const card = (id = 'card'): Row => ({ id, family_id: family, kind: 'insurance', source_kind: 'family_insurance_policies', source_id: 'policy', member_id: named.memberId, action_type: 'create_reminder', title: 'Synthetic policy reminder', detail: 'Synthetic detail', urgency: 1, payload: {} });
function database(tables: Record<string, Row[]> = {}, cap = 1000, errors: Record<string, { message: string }> = {}) {
  const logs: PageLog[] = [];
  const db = { from(table: string) {
    let columns = '';
    const filters: Record<string, unknown> = {};
    const query = {
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      order() { return query; },
      range(from: number, to: number) {
        logs.push({ table, columns, from, to, filters: { ...filters } });
        const filtered = (tables[table] ?? []).filter(row => Object.entries(filters).every(([key, value]) => row[key] === value));
        return Promise.resolve({ data: errors[table] ? null : filtered.slice(from, Math.min(to + 1, from + cap)), error: errors[table] ?? null });
      },
    };
    return query;
  } } as unknown as Parameters<typeof readReminderCards>[0];
  return { db, logs };
}
async function load(tables: Record<string, Row[]>, cap = 1000, errors: Record<string, { message: string }> = {}, mints: { keyOf: (id: string) => string; sourceTagOf: () => string } | undefined = undefined) {
  const adapter = database(tables, cap, errors);
  const observed: unknown[] = [];
  const onError = (error: unknown) => { observed.push(error); };
  const options = mints ? { ...mints, onError } : { onError };
  const cards = await readReminderCards(adapter.db, family, options);
  return { cards, observed, logs: adapter.logs };
}
const linked = { autopilot_suggestions: [card()], family_reminders: [origin('reminder')] };

describe('immutable reminder origin reader qualification', () => {
  it('manual origins in both tables preserve ordinary viewer visibility', async () => {
    const { cards, observed } = await load({ family_reminders: [origin('manual-family', false, null)], reminders: [origin('manual-legacy', false, null)] });
    expect(observed).toEqual([]);
    for (const id of ['manual-family', 'manual-legacy']) expect(reminderVisibleTo({ id }, cards, other)).toBe(true);
  });
  it('exact immutable card origin admits named viewer and manager', async () => {
    const { cards, observed } = await load(linked);
    expect(observed).toEqual([]);
    expect(reminderVisibleTo({ id: 'reminder' }, cards, named)).toBe(true);
    expect(reminderVisibleTo({ id: 'reminder' }, cards, manager)).toBe(true);
  });
  it('exact immutable card origin refuses a different requesting viewer', async () => {
    const { cards } = await load(linked);
    const requester = { ...other };
    expect(reminderVisibleTo({ id: 'reminder' }, cards, requester)).toBe(false);
    expect(await visibleReminders([{ id: 'reminder' }], requester, async () => cards)).toEqual([]);
  });
  it('absent deleted and historical origins remain manager only', async () => {
    const { cards } = await load({ family_reminders: [origin('deleted', true, 'deleted-card'), origin('history', true, null)] });
    for (const id of ['absent', 'deleted', 'history']) {
      expect(reminderVisibleTo({ id }, cards, named)).toBe(false);
      expect(reminderVisibleTo({ id }, cards, manager)).toBe(true);
    }
  });
  it('projections omitting origin fields resolve through both trusted table maps', async () => {
    const { cards, logs } = await load({ autopilot_suggestions: [card()], family_reminders: [origin('family-copy')], reminders: [origin('scan-copy')] });
    const projected: ReminderLink[] = [{ id: 'family-copy' }, { id: 'scan-copy' }];
    expect(await visibleReminders(projected, named, async () => cards)).toEqual(projected);
    expect(await visibleReminders(projected, other, async () => cards)).toEqual([]);
    for (const table of ['family_reminders', 'reminders']) {
      const requests = logs.filter(log => log.table === table);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(log => log.columns === 'id, family_id, autopilot_origin, autopilot_card_id' && log.filters.family_id === family)).toBe(true);
    }
  });
  it('known foreign family rows refuse managers and named viewers; mismatched source cards remain unresolved', async () => {
    const { cards } = await load(linked);
    for (const viewer of [manager, named]) expect(reminderVisibleTo({ id: 'reminder', family_id: 'foreign-family' }, cards, viewer)).toBe(false);
    const mismatch = await load({ autopilot_suggestions: [{ ...card(), family_id: 'foreign-family' }], family_reminders: [origin('reminder')] });
    expect(reminderVisibleTo({ id: 'reminder' }, mismatch.cards, named)).toBe(false);
    expect(reminderVisibleTo({ id: 'reminder' }, mismatch.cards, manager)).toBe(true);
  });
  it('duplicate reminder IDs across tables remain unresolved', async () => {
    const { cards, observed } = await load({ ...linked, reminders: [origin('reminder', false, null)] });
    expect(observed).toEqual([]);
    expect(reminderVisibleTo({ id: 'reminder' }, cards, named)).toBe(false);
    expect(reminderVisibleTo({ id: 'reminder' }, cards, manager)).toBe(true);
  });
  it('origin read errors and missing schema fail closed with onError', async () => {
    for (const table of ['family_reminders', 'reminders']) for (const message of ['Synthetic read failure', 'column autopilot_origin does not exist']) {
      const failure = { message };
      const result = await load(linked, 1000, { [table]: failure });
      expect(result.cards).toBeNull();
      expect(result.observed).toEqual([failure]);
      expect(reminderVisibleTo({ id: 'reminder' }, result.cards, named)).toBe(false);
    }
    const malformed = await load({ family_reminders: [{ id: 'manual', family_id: family, autopilot_card_id: null }] });
    expect(malformed.cards).toBeNull();
    expect(malformed.observed).toHaveLength(1);
  });
  it('card read failure preserves onError and manager only fallback', async () => {
    const failure = { message: 'Synthetic card read failure' };
    const result = await load(linked, 1000, { autopilot_suggestions: failure });
    expect(result.cards).toBeNull(); expect(result.observed).toEqual([failure]);
    expect(reminderVisibleTo({ id: 'reminder' }, result.cards, named)).toBe(false);
    expect(reminderVisibleTo({ id: 'reminder' }, result.cards, manager)).toBe(true);
    expect(result.logs.every(log => log.table === 'autopilot_suggestions')).toBe(true);
  });
  it('compatibility key and source tag mint failures remain read failures', async () => {
    for (const failing of ['key', 'tag']) {
      const failure = new Error('Synthetic ' + failing + ' mint failure');
      const result = await load(linked, 1000, {}, { keyOf: () => { if (failing === 'key') throw failure; return 'synthetic-key'; }, sourceTagOf: () => { if (failing === 'tag') throw failure; return 'synthetic-tag'; } });
      expect(result.cards).toBeNull(); expect(result.observed).toEqual([failure]);
    }
  });
  it('origin and card paging advance by actual returned rows through empty pages', async () => {
    const result = await load({ autopilot_suggestions: [card('card-a'), card('card-b'), card('card-c')], family_reminders: [origin('a', true, 'card-a'), origin('b', true, 'card-b'), origin('c', true, 'card-c')], reminders: [origin('manual', false, null)] }, 1);
    expect(result.observed).toEqual([]);
    expect(reminderVisibleTo({ id: 'c' }, result.cards, named)).toBe(true);
    for (const table of ['autopilot_suggestions', 'family_reminders']) expect(result.logs.filter(log => log.table === table).map(log => log.from)).toEqual([0, 1, 2, 3]);
    expect(result.logs.filter(log => log.table === 'reminders').map(log => log.from)).toEqual([0, 1]);
  });
  it('visible reminder prefix finds later allowed rows past capped hidden pages', async () => {
    const result = await load({ ...linked, family_reminders: [origin('hidden', true, null), origin('named'), origin('manual', false, null)] }, 1);
    const rows = [{ id: 'hidden' }, { id: 'named' }, { id: 'manual' }];
    const offsets: number[] = [];
    const prefix = await readVisibleReminders(async (from) => { offsets.push(from); return { data: rows.slice(from, from + 1), error: null }; }, { limit: 2, viewer: named, cards: async () => result.cards });
    expect(prefix.error).toBeNull(); expect(prefix.data).toEqual([{ id: 'named' }, { id: 'manual' }]); expect(offsets).toEqual([0, 1, 2]);
  });
  it('trusted manual metadata avoids unavailable unrelated cards and mint callbacks', async () => {
    for (const unavailable of [false, true]) {
      const adapter = database({ autopilot_suggestions: [card('unrelated')], family_reminders: [origin('manual-family', false, null)], reminders: [origin('manual-legacy', false, null)] }, 1, unavailable ? { autopilot_suggestions: { message: 'Synthetic unrelated card failure' } } : {});
      const errors: unknown[] = [];
      let keys = 0; let tags = 0;
      const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); }, keyOf: () => { keys++; throw new Error('Unrelated key mint unavailable'); }, sourceTagOf: () => { tags++; throw new Error('Unrelated tag mint unavailable'); } });
      const rows = [{ id: 'manual-family' }, { id: 'manual-legacy' }];
      expect(await visibleReminders(rows, other, reader)).toEqual(rows);
      expect(errors).toEqual([]); expect(keys).toBe(0); expect(tags).toBe(0);
      expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
      for (const table of ['family_reminders', 'reminders']) expect(adapter.logs.some(log => log.table === table)).toBe(true);
    }
  });
  it('manual first pages upgrade the reader for later generated and unknown rows without widening audience', async () => {
    const tables = { autopilot_suggestions: [card(), { ...card('hidden-card'), member_id: other.memberId }], family_reminders: [origin('manual-first', false, null), origin('named'), origin('hidden', true, 'hidden-card'), origin('manual-last', false, null)] };
    const adapter = database(tables, 1);
    const errors: unknown[] = [];
    const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
    const manual = await reader([{ id: 'manual-first' }]);
    expect(manual?.byCardId?.size).toBe(0);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
    const rows = [{ id: 'manual-first' }, { id: 'named' }, { id: 'hidden' }, { id: 'unknown' }, { id: 'manual-last' }];
    const offsets: number[] = [];
    const result = await readVisibleReminders(async from => { offsets.push(from); return { data: rows.slice(from, from + 1), error: null }; }, { limit: 3, viewer: named, cards: reader });
    expect(result.error).toBeNull(); expect(result.data).toEqual([rows[0], rows[1], rows[4]]); expect(offsets).toEqual([0, 1, 2, 3, 4]);
    const full = await reader();
    expect(full?.byCardId?.size).toBe(2);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0, 1, 2]);
    expect(await visibleReminders([{ id: 'hidden' }, { id: 'unknown' }], named, reader)).toEqual([]);
    expect(await reader([{ id: 'named' }])).toBe(full);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0, 1, 2]);
    expect(errors).toEqual([]);
    const legacyAdapter = database(tables, 1);
    const legacyReader = reminderCardsReader(legacyAdapter.db, family, { onError: error => { errors.push(error); } });
    expect((await legacyReader())?.byCardId?.size).toBe(2);
    expect(legacyAdapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0, 1, 2]);
  });
  it('mixed manual and generated projections retain strict card-read error propagation', async () => {
    const rows = [{ id: 'manual' }, { id: 'generated' }];
    const tables = { autopilot_suggestions: [card()], family_reminders: [origin('manual', false, null), origin('generated')] };
    const failure = { message: 'Synthetic generated-card read failure' };
    const adapter = database(tables, 1000, { autopilot_suggestions: failure });
    const errors: unknown[] = [];
    const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
    expect(await visibleReminders([rows[0]], named, reader)).toEqual([rows[0]]);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
    expect(await reader(rows)).toBeNull(); expect(errors).toEqual([failure]);
    expect(await visibleReminders(rows, named, reader)).toEqual([]);
    expect(errors).toEqual([failure]);
    const mintAdapter = database(tables);
    const mintErrors: unknown[] = [];
    const mintFailure = new Error('Synthetic unrelated mint failure');
    let keys = 0;
    const mintReader = reminderCardsReader(mintAdapter.db, family, { onError: error => { mintErrors.push(error); }, keyOf: () => { keys++; throw mintFailure; }, sourceTagOf: () => 'synthetic-tag' });
    expect(await visibleReminders([rows[0]], named, mintReader)).toEqual([rows[0]]); expect(keys).toBe(0);
    expect(await mintReader([rows[1]])).toBeNull(); expect(mintErrors).toEqual([mintFailure]); expect(keys).toBe(1);
    expect(await visibleReminders([rows[0]], named, mintReader)).toEqual([rows[0]]); expect(keys).toBe(1); expect(mintErrors).toEqual([mintFailure]);
  });
  it('manual projections still refuse failed origin metadata and missing schema', async () => {
    for (const table of ['family_reminders', 'reminders']) for (const message of ['Synthetic origin read failure', 'column autopilot_origin does not exist']) {
      const adapter = database({ family_reminders: [origin('manual', false, null)] }, 1000, { [table]: { message } });
      const errors: unknown[] = [];
      const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
      expect(await reader([{ id: 'manual' }])).toBeNull(); expect(errors).toEqual([{ message }]);
      expect(await visibleReminders([{ id: 'manual' }], other, reader)).toEqual([]);
      expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
    }
    const malformedAdapter = database({ family_reminders: [{ id: 'manual', family_id: family, autopilot_card_id: null }] });
    const malformedErrors: unknown[] = [];
    const malformedReader = reminderCardsReader(malformedAdapter.db, family, { onError: error => { malformedErrors.push(error); } });
    expect(await malformedReader([{ id: 'manual' }])).toBeNull(); expect(malformedErrors).toHaveLength(1);
    expect(malformedAdapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
    for (const duplicate of [false, true]) {
      const adapter = database({ family_reminders: duplicate ? [origin('manual', false, null)] : [], reminders: duplicate ? [origin('manual', false, null)] : [] });
      const reader = reminderCardsReader(adapter.db, family, { onError: () => { throw new Error('Unexpected metadata error'); } });
      expect(await visibleReminders([{ id: 'manual' }], other, reader)).toEqual([]);
      expect(adapter.logs.some(log => log.table === 'autopilot_suggestions')).toBe(true);
    }
    const foreignAdapter = database({ family_reminders: [origin('manual', false, null)] });
    const foreignReader = reminderCardsReader(foreignAdapter.db, family, { onError: () => { throw new Error('Unexpected family error'); } });
    for (const viewer of [named, manager]) expect(await visibleReminders([{ id: 'manual', family_id: 'foreign-family' }], viewer, foreignReader)).toEqual([]);
    expect(foreignAdapter.logs.some(log => log.table === 'autopilot_suggestions')).toBe(true);
  });
  it('display opt-in preserves the healthy mixed audience and cached card read', async () => {
    const rows = [{ id: 'manual' }, { id: 'generated' }];
    const adapter = database({ autopilot_suggestions: [card()], family_reminders: [origin('manual', false, null), origin('generated')] });
    const errors: unknown[] = [];
    const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
    expect(await visibleReminders(rows, named, reader, { preserveTrustedManualOnCardError: true })).toEqual(rows);
    expect(await visibleReminders(rows, other, reader, { preserveTrustedManualOnCardError: true })).toEqual([rows[0]]);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0, 1]);
    expect(errors).toEqual([]);
  });
  it('display opt-in retains trusted manual rows during card failure and refuses generated rows', async () => {
    const rows = [{ id: 'manual' }, { id: 'generated' }];
    const failure = { message: 'Synthetic display card failure' };
    const adapter = database({ family_reminders: [origin('manual', false, null), origin('generated')] }, 1000, { autopilot_suggestions: failure });
    const errors: unknown[] = [];
    const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
    expect(await reader(rows)).toBeNull();
    expect(await visibleReminders(rows, named, reader, { preserveTrustedManualOnCardError: true })).toEqual([rows[0]]);
    const result = await readVisibleReminders(async from => ({ data: from === 0 ? rows : [], error: null }), { limit: 2, viewer: named, cards: reader, preserveTrustedManualOnCardError: true });
    expect(result).toEqual({ data: [rows[0]], error: null });
    expect(await visibleReminders(rows, manager, reader, { preserveTrustedManualOnCardError: true })).toEqual(rows);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0]);
    expect(errors).toEqual([failure]);
  });
  it('display opt-in refuses failed or malformed immutable metadata without reading cards', async () => {
    for (const unavailable of ['read', 'schema', 'malformed']) {
      const failure = { message: unavailable === 'schema' ? 'column autopilot_origin does not exist' : 'Synthetic display origin failure' };
      const tables = { family_reminders: unavailable === 'malformed' ? [{ id: 'manual', family_id: family, autopilot_card_id: null }] : [origin('manual', false, null), origin('generated')] };
      const adapter = database(tables, 1000, unavailable === 'malformed' ? {} : { family_reminders: failure });
      const errors: unknown[] = [];
      const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
      expect(await visibleReminders([{ id: 'manual' }, { id: 'generated' }], named, reader, { preserveTrustedManualOnCardError: true })).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions')).toEqual([]);
    }
  });
  it('display opt-in refuses collision foreign and unknown rows while preserving only trusted manual rows', async () => {
    const rows = [{ id: 'manual' }, { id: 'collision' }, { id: 'manual', family_id: 'foreign-family' }, { id: 'unknown' }, { id: 'generated' }];
    const failure = { message: 'Synthetic display card failure' };
    const adapter = database({ family_reminders: [origin('manual', false, null), origin('collision', false, null), origin('generated')], reminders: [origin('collision', false, null)] }, 1000, { autopilot_suggestions: failure });
    const errors: unknown[] = [];
    const reader = reminderCardsReader(adapter.db, family, { onError: error => { errors.push(error); } });
    expect(await visibleReminders(rows, named, reader, { preserveTrustedManualOnCardError: true })).toEqual([rows[0]]);
    expect(await visibleReminders(rows, named, reader)).toEqual([]);
    expect(adapter.logs.filter(log => log.table === 'autopilot_suggestions').map(log => log.from)).toEqual([0]);
    expect(errors).toEqual([failure]);
  });
});