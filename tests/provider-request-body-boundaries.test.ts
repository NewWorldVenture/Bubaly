import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const providerRoutes = [
  'app/api/admin/marketing/ai/route.ts',
  'app/api/admin/marketing/email/send/route.ts',
  'app/api/ai/assist/route.ts',
  'app/api/ai/auto/accident/route.ts',
  'app/api/ai/briefing/route.ts',
  'app/api/ai/chat/route.ts',
  'app/api/ai/chef/route.ts',
  'app/api/ai/flyer/route.ts',
  'app/api/ai/gift/route.ts',
  'app/api/ai/health/coach/route.ts',
  'app/api/ai/home/diagnose/route.ts',
  'app/api/ai/home/find-pro/route.ts',
  'app/api/ai/home/forecast/route.ts',
  'app/api/ai/import/route.ts',
  'app/api/ai/insights/route.ts',
  'app/api/ai/invest/route.ts',
  'app/api/ai/meals/nutrition/route.ts',
  'app/api/ai/meals/plan/route.ts',
  'app/api/ai/notes/route.ts',
  'app/api/ai/resolve-conflict/route.ts',
  'app/api/ai/schedule/route.ts',
  'app/api/ai/trip/route.ts',
  'app/api/ai/voice/speak/route.ts',
  'app/api/ai/weekly-briefing/route.ts',
  'app/api/behavior/insight/route.ts',
  'app/api/exit-intent/resolve/route.ts',
  'app/api/guardian/escalate/route.ts',
  'app/api/mkt/consent/route.ts',
  'app/api/recipes/suggest/route.ts',
  'app/api/recipes/transform/route.ts',
  'app/api/social/ai/route.ts',
  'app/api/vacations/ai/route.ts',
  'app/api/vacations/weather/route.ts',
  'app/api/weekend/discover/route.ts',
];

describe('provider-backed JSON request boundaries', () => {
  it('keeps every audited route behind the shared bounded reader', () => {
    for (const file of providerRoutes) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/readBoundedRequestJson/);
      expect(source, file).not.toMatch(/\b(req|request)\.json\(\)/);
    }
  });
});
