import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routes = [
  'app/api/weekend/discover/route.ts',
  'app/api/ai/meals/plan/route.ts',
  'app/api/ai/flyer/route.ts',
  'app/api/ai/meals/nutrition/route.ts',
  'app/api/vacations/weather/route.ts',
  'app/api/vacations/ai/route.ts',
  'app/api/google/calendar/sync/route.ts',
  'app/api/concierge-calls/place/route.ts',
  'app/api/cron/calendar-feeds/route.ts',
  'app/api/cron/chore-reminders/route.ts',
  'app/api/cron/checkout-abandoned/route.ts',
  'app/api/cron/push-scan/route.ts',
  'app/api/cron/notifications/route.ts',
  'app/api/cron/provider-sync/route.ts',
];

describe('API database error boundaries', () => {
  it('does not return raw Supabase messages to callers', () => {
    for (const route of routes) {
      const source = readFileSync(route, 'utf8');
      expect(source).not.toMatch(/NextResponse\.json\(\{[^\n]*error:\s*error\.message/);
    }
  });
});
