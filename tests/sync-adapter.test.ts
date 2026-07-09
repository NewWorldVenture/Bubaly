import { describe, it, expect } from 'vitest';
import { REQUIRED_ADAPTER_METHODS, type SyncProviderAdapter } from '@/lib/sync/adapter';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import {
  microsoftAdapter, msEventToRow, rowToMsEvent, msTaskToRow, rowToMsTask, type MsEvent, type MsTask,
} from '@/lib/sync/providers/microsoft';
import { getAdapter, listAdapters, configuredAdapters, isProviderConfigured } from '@/lib/sync/registry';

const ADAPTERS: [string, SyncProviderAdapter][] = [
  ['google', googleAdapter],
  ['microsoft', microsoftAdapter],
];

describe('adapter contract conformance', () => {
  it.each(ADAPTERS)('%s implements every required method', (_name, adapter) => {
    for (const m of REQUIRED_ADAPTER_METHODS) {
      expect(typeof (adapter as unknown as Record<string, unknown>)[m], `${_name}.${m}`).toBe('function');
    }
    expect(typeof adapter.provider).toBe('string');
    expect(typeof adapter.label).toBe('string');
  });

  it('each adapter declares the matching provider enum value', () => {
    expect(googleAdapter.provider).toBe('google');
    expect(microsoftAdapter.provider).toBe('microsoft');
  });
});

describe('registry', () => {
  it('resolves registered providers and returns null for the rest', () => {
    expect(getAdapter('google')).toBe(googleAdapter);
    expect(getAdapter('microsoft')).toBe(microsoftAdapter);
    expect(getAdapter('apple')).toBeNull();
    expect(getAdapter('amazon')).toBeNull();
  });

  it('lists all registered adapters', () => {
    const ids = listAdapters().map((a) => a.provider).sort();
    expect(ids).toEqual(['google', 'microsoft']);
  });

  it('gates configured adapters on keys (none set in test env)', () => {
    expect(isProviderConfigured('microsoft')).toBe(false);
    expect(configuredAdapters()).toEqual([]);
  });
});

describe('microsoft auth', () => {
  it('builds a v2.0 authorize URL requesting offline_access', () => {
    const url = microsoftAdapter.authUrl('https://app.example/cb', 'state123');
    expect(url).toContain('oauth2/v2.0/authorize');
    expect(url).toContain('state=state123');
    expect(decodeURIComponent(url)).toContain('offline_access');
  });
});

describe('microsoft pure event mappers', () => {
  it('maps a timed Graph event to a normalized row (naive datetime treated as UTC)', () => {
    const ev: MsEvent = {
      id: 'evt1', iCalUId: 'uid-1', subject: 'Dentist',
      body: { content: 'bring insurance card' }, location: { displayName: 'Main St Dental' },
      start: { dateTime: '2026-07-10T15:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-07-10T16:00:00.0000000', timeZone: 'UTC' },
      isAllDay: false, changeKey: 'ck1', lastModifiedDateTime: '2026-07-09T00:00:00Z',
    };
    const row = msEventToRow(ev);
    expect(row).toMatchObject({
      external_id: 'evt1', uid: 'uid-1', title: 'Dentist',
      description: 'bring insurance card', location: 'Main St Dental',
      all_day: false, status: 'confirmed', etag: 'ck1', cancelled: false,
    });
    expect(row.starts_at).toBe('2026-07-10T15:00:00.000Z');
    expect(row.ends_at).toBe('2026-07-10T16:00:00.000Z');
  });

  it('flags a removed/cancelled event', () => {
    const row = msEventToRow({ id: 'e2', '@removed': { reason: 'deleted' }, start: { dateTime: '2026-01-01T00:00:00Z' } });
    expect(row.cancelled).toBe(true);
    expect(row.status).toBe('cancelled');
  });

  it('falls back to a title placeholder when subject is missing', () => {
    const row = msEventToRow({ id: 'e3', start: { dateTime: '2026-01-01T00:00:00Z' } });
    expect(row.title).toBe('(no title)');
  });

  it('round-trips a timed row into a Graph request body', () => {
    const body = rowToMsEvent({ title: 'Soccer', starts_at: '2026-07-11T14:00:00.000Z', ends_at: '2026-07-11T15:00:00.000Z', location: 'Field 3' });
    expect(body.subject).toBe('Soccer');
    expect(body.location).toEqual({ displayName: 'Field 3' });
    expect((body.start as { dateTime: string }).dateTime).not.toContain('Z'); // Graph wants naive + timeZone
    expect((body.start as { timeZone: string }).timeZone).toBe('UTC');
  });

  it('emits date-only bounds for an all-day row', () => {
    const body = rowToMsEvent({ title: 'Trip', starts_at: '2026-08-01T00:00:00.000Z', all_day: true });
    expect(body.isAllDay).toBe(true);
    expect((body.start as { dateTime: string }).dateTime).toBe('2026-08-01T00:00:00');
  });
});

describe('microsoft pure task mappers', () => {
  it('maps a completed Graph task to a reminder row', () => {
    const task: MsTask = {
      id: 't1', title: 'Pay tuition', body: { content: 'fall term' },
      status: 'completed', dueDateTime: { dateTime: '2026-09-01T00:00:00Z', timeZone: 'UTC' },
      completedDateTime: { dateTime: '2026-08-30T00:00:00Z', timeZone: 'UTC' },
    };
    const row = msTaskToRow(task);
    expect(row).toMatchObject({ external_id: 't1', title: 'Pay tuition', notes: 'fall term', is_completed: true });
    expect(row.due_at).toBe('2026-09-01T00:00:00.000Z');
    expect(row.completed_at).toBe('2026-08-30T00:00:00.000Z');
  });

  it('round-trips a reminder row into a Graph task body', () => {
    const body = rowToMsTask({ title: 'Renew passport', notes: 'expedited', due_at: '2026-10-01T00:00:00.000Z', is_completed: false });
    expect(body.title).toBe('Renew passport');
    expect(body.status).toBe('notStarted');
    expect(body.body).toEqual({ contentType: 'text', content: 'expedited' });
    expect((body.dueDateTime as { dateTime: string }).dateTime).not.toContain('Z');
  });
});

describe('provider-neutral content hashing', () => {
  it('google and microsoft hash the same normalized event identically', () => {
    const row = { title: 'Recital', description: null, location: 'Hall', starts_at: '2026-07-10T15:00:00.000Z', ends_at: null, all_day: false, recurrence_rule: null };
    expect(microsoftAdapter.eventContentHash(row)).toBe(googleAdapter.eventContentHash(row));
  });

  it('the same reminder hashes identically across adapters', () => {
    const row = { title: 'Trash', notes: null, due_at: '2026-07-10T00:00:00.000Z', is_completed: false };
    expect(microsoftAdapter.reminderContentHash(row)).toBe(googleAdapter.reminderContentHash(row));
  });

  it('a content change changes the digest', () => {
    const a = microsoftAdapter.eventContentHash({ title: 'A', starts_at: '2026-07-10T15:00:00.000Z' });
    const b = microsoftAdapter.eventContentHash({ title: 'B', starts_at: '2026-07-10T15:00:00.000Z' });
    expect(a).not.toBe(b);
  });
});
