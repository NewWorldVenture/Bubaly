import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('scheduled recovery failure contracts', () => {
  it('surfaces Guardian Learning cleanup, reads, and family failures', () => {
    const source = read('app/api/cron/guardian-learning/route.ts');
    expect(source).toContain('dismissError');
    expect(source).toContain('recentError');
    expect(source).toContain('const ok = failed === 0;');
    expect(source).toContain('{ status: ok ? 200 : 502 }');
  });

  it('sanitizes and fails the Network Aggregation cron when its core fails', () => {
    const source = read('app/api/cron/network-aggregate/route.ts');
    expect(source).toContain("error: 'Network aggregation failed.'");
    expect(source).toContain('{ status: result.ok ? 200 : 502 }');
    expect(source).not.toContain('return NextResponse.json(result)');
  });

  it('counts auction notification and provider audit failures', () => {
    const auctions = read('app/api/cron/close-auctions/route.ts');
    const providers = read('app/api/cron/provider-sync/route.ts');
    expect(auctions).toContain('notificationError');
    expect(auctions).toContain('failed++');
    expect(providers).toContain('auditFailed');
    expect(providers).toContain('const ok = failed === 0 && auditFailed === 0;');
  });

  it('does not acknowledge calendar feeds after event or status persistence fails', () => {
    const source = read('lib/server/calendar-feeds.ts');
    expect(source).toContain('Calendar feed event upsert failed');
    expect(source).toContain('Calendar feed status could not be saved');
    expect(source).toContain("const { error } = await supabase.from('calendar_feeds').update");
  });
});
