import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const route = readFileSync(resolve(process.cwd(), 'app/api/webhooks/resend/route.ts'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/0180_resend_webhook_dedup.sql'), 'utf8');

describe('Resend webhook replay contract', () => {
  it('requires fresh Svix signatures and durable event deduplication', () => {
    expect(route).toContain('svix-timestamp');
    expect(route).toContain('Math.abs(nowMs / 1000 - timestampSeconds) > 300');
    expect(route).toContain('resend_webhook_events');
    expect(route).toContain("status === 'processed'");
    expect(route).toContain('Payload too large');
    expect(migration).toContain('svix_id      text primary key');
    expect(migration).toContain('alter table public.resend_webhook_events enable row level security');
  });
});
