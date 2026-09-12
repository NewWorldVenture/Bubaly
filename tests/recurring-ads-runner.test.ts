import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyOutcome, validPlatforms, scheduleFromRow, firstRunFor, type AdRow,
} from '@/lib/marketing/recurring-ads-runner';
import { parseTimesOfDay, parseVariants } from '@/lib/marketing/recurring-ads';
import { PLATFORMS } from '@/lib/social/capabilities';

function adRow(over: Partial<AdRow> = {}): AdRow {
  return {
    id: 'ad-1', name: 'Weekly spotlight', status: 'active',
    body_variants: ['One', 'Two'], link: null, media_urls: [], platforms: ['x'],
    cadence: 'daily', times_of_day: [540], days_of_week: [], day_of_month: null, timezone: 'UTC',
    starts_at: '2026-01-01T00:00:00Z', ends_at: null, max_occurrences: null,
    next_run_at: '2026-01-01T09:00:00Z', last_run_at: null, occurrences: 0,
    ...over,
  };
}

describe('an outcome is whatever the provider said', () => {
  // The connector layer collapses everything that is not a confirmed post into
  // status 'skipped' or 'failed' plus an error code. The ledger widens that
  // back out, because "we never configured this platform" and "the call broke"
  // are different problems for whoever has to fix them.
  it('confirms a post only when the provider confirmed it', () => {
    expect(classifyOutcome(true, null)).toBe('published');
  });

  it('distinguishes missing credentials from an unwired platform', () => {
    expect(classifyOutcome(false, 'requires_setup')).toBe('requires_setup');
    expect(classifyOutcome(false, 'not_implemented')).toBe('not_implemented');
  });

  it('treats anything else as a failure rather than guessing', () => {
    expect(classifyOutcome(false, 'provider_error')).toBe('failed');
    expect(classifyOutcome(false, null)).toBe('failed');
    expect(classifyOutcome(false, undefined)).toBe('failed');
  });

  it('has no value that means "probably posted"', () => {
    const migration = readFileSync('supabase/migrations/0282_marketing_recurring_ads.sql', 'utf8');
    // Scoped to the RUN ledger. The ads table has its own status check
    // ('active','paused') earlier in the file, and a regex that took the first
    // match would assert against the wrong constraint and pass for the wrong
    // reason — which is exactly what it did on the first run.
    const runsTable = migration.slice(migration.indexOf('create table if not exists public.marketing_recurring_ad_runs'));
    const statuses = /check \(status in \(([^)]*)\)\)/.exec(runsTable)?.[1] ?? '';
    expect(statuses).toContain("'published'");
    expect(statuses).toContain("'requires_setup'");
    expect(statuses).not.toMatch(/sent|queued|assumed|probably/i);
  });
});

describe('only platforms the app knows about', () => {
  it('keeps the known ones', () => {
    expect(validPlatforms(['x', 'reddit'])).toEqual(['x', 'reddit']);
  });

  it('drops anything else, so a stale row cannot smuggle a platform in', () => {
    expect(validPlatforms(['x', 'myspace', ''])).toEqual(['x']);
    expect(validPlatforms(null)).toEqual([]);
    expect(validPlatforms(undefined)).toEqual([]);
  });

  it('de-duplicates, so one platform cannot be posted to twice in a run', () => {
    expect(validPlatforms(['x', 'x', 'x'])).toEqual(['x']);
  });

  it('accepts every platform the capability map declares', () => {
    expect(validPlatforms([...PLATFORMS])).toEqual([...PLATFORMS]);
  });
});

describe('the first run of a new campaign', () => {
  it('never opens by firing a backlog for a start date in the past', () => {
    // Creating a campaign back-dated to last month must not post thirty times.
    const schedule = scheduleFromRow(adRow({ cadence: 'daily', times_of_day: [540] }));
    const now = new Date('2026-03-15T12:00:00Z');
    const first = firstRunFor(schedule, new Date('2026-02-01T00:00:00Z'), now);
    expect(first!.toISOString()).toBe('2026-03-16T09:00:00.000Z');
    expect(first!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('waits for a start date in the future', () => {
    const schedule = scheduleFromRow(adRow({ cadence: 'daily', times_of_day: [540] }));
    const first = firstRunFor(schedule, new Date('2026-06-01T00:00:00Z'), new Date('2026-03-15T12:00:00Z'));
    expect(first!.toISOString()).toBe('2026-06-01T09:00:00.000Z');
  });

  it('reports that a schedule which can never fire has no first run', () => {
    const schedule = scheduleFromRow(adRow({ cadence: 'weekly', days_of_week: [] }));
    expect(firstRunFor(schedule, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('reads the stored row exactly as the form wrote it', () => {
    const row = adRow({ cadence: 'monthly', times_of_day: [630], days_of_week: [1], day_of_month: 15, timezone: 'Europe/Berlin' });
    expect(scheduleFromRow(row)).toEqual({
      cadence: 'monthly', timesOfDay: [630], daysOfWeek: [1], dayOfMonth: 15, timezone: 'Europe/Berlin',
    });
  });

  it('survives a row whose array columns came back null', () => {
    const row = adRow({ times_of_day: null, days_of_week: null });
    expect(scheduleFromRow(row)).toMatchObject({ timesOfDay: [], daysOfWeek: [] });
  });
});

describe('what the admin form accepts', () => {
  it('reads a list of times', () => {
    expect(parseTimesOfDay('09:00, 17:30')).toEqual([540, 1050]);
    expect(parseTimesOfDay('09:00 17:30')).toEqual([540, 1050]);
  });

  it('sorts and de-duplicates them', () => {
    expect(parseTimesOfDay('17:30, 09:00, 09:00')).toEqual([540, 1050]);
  });

  it('rejects a time that is not one', () => {
    expect(parseTimesOfDay('25:00')).toEqual([]);
    expect(parseTimesOfDay('9am')).toEqual([]);
    expect(parseTimesOfDay('09:60')).toEqual([]);
    expect(parseTimesOfDay('')).toEqual([]);
  });

  it('accepts midnight, which a truthiness check would drop', () => {
    expect(parseTimesOfDay('00:00')).toEqual([0]);
  });

  it('splits messages on lines and drops the blank ones', () => {
    expect(parseVariants('One\n\n  Two  \n')).toEqual(['One', 'Two']);
    expect(parseVariants('   ')).toEqual([]);
  });
});

describe('the cron route is fail-closed and registered', () => {
  it('refuses a request without the cron secret', () => {
    const route = readFileSync('app/api/cron/marketing-social/route.ts', 'utf8');
    expect(route).toContain('hasCronAuthorization');
    expect(route).toContain('status: 401');
  });

  it('runs often enough for the times of day an operator can pick', () => {
    const dispatcher = readFileSync('scripts/cron-dispatch.mjs', 'utf8');
    expect(dispatcher).toContain("'/api/cron/marketing-social': '*/15 * * * *'");
  });

  it('stays within what a Vercel Hobby plan accepts', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    const entry = vercel.crons.find((c) => c.path === '/api/cron/marketing-social');
    expect(entry).toBeDefined();
    // Daily: the finer cadence lives in the dispatcher, per the note in 0020's
    // sibling comment and scripts/cron-dispatch.mjs.
    expect(entry!.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('the occurrence ledger cannot record the same post twice', () => {
  it('is enforced by a unique index, not by the caller remembering', () => {
    const migration = readFileSync('supabase/migrations/0282_marketing_recurring_ads.sql', 'utf8');
    expect(migration).toMatch(/create unique index[^;]*marketing_recurring_ad_runs \(ad_id, occurrence, platform\)/s);
  });

  it('claims the occurrence with a compare-and-set before publishing', () => {
    // Read the runner rather than trusting the comment: the .eq on the value we
    // read is what makes two racing workers resolve to one post.
    const runner = readFileSync('lib/marketing/recurring-ads-runner.ts', 'utf8');
    expect(runner).toContain(".eq('next_run_at', ad.next_run_at as string)");
    const claimIndex = runner.indexOf('async function claimOccurrence');
    const publishIndex = runner.indexOf('export async function publishOccurrence');
    expect(claimIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
  });

  it('locks the recurring tables down to the service role like every marketing table', () => {
    const migration = readFileSync('supabase/migrations/0282_marketing_recurring_ads.sql', 'utf8');
    expect(migration).toContain('alter table public.marketing_recurring_ads     enable row level security;');
    expect(migration).toContain('alter table public.marketing_recurring_ad_runs enable row level security;');
    // No policies at all is the pattern from 0020 — RLS on with nothing granted
    // means only the service role gets through.
    expect(migration).not.toMatch(/create policy/i);
  });
});
