import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/guardian/twilio', () => ({
  isTwilioConfigured: () => true,
  searchAvailableNumber: async () => '+15550001111',
  provisionNumber: async () => ({ phoneNumber: '+15550001111', sid: 'PN-test' }),
}));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: vi.fn() }));
vi.mock('@/lib/services/paperwork', () => ({ enrichPaperworkEntities: vi.fn(), PaperworkEnrichmentError: class extends Error {} }));

const { provisionFamilyNumber } = await import('@/lib/contact-center/server');

/**
 * Audit C1-S9-69 — a Twilio number that is bought is saved to the family, or
 * the caller is told it was not.
 *
 * The number is purchased before the channel row is written. A write that
 * matched nothing answered `{ ok: true, phoneNumber }` while the family's
 * channel held no number: inbound calls to it could not be routed to them, and
 * it went on billing.
 */
function admin(saveRows: unknown[]) {
  const from = () => {
    let op: 'select' | 'update' = 'select';
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => (op === 'update' ? Promise.resolve({ data: saveRows, error: null }) : b),
      eq: () => b,
      update: () => { op = 'update'; return b; },
      maybeSingle: async () => ({ data: { family_id: 'fam-1', phone_number: null }, error: null }),
    });
    return b;
  };
  return { from } as never;
}

describe('provisionFamilyNumber (C1-S9-69)', () => {
  it('reports a bought number whose save matched nothing, and does not claim success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await provisionFamilyNumber(admin([]), 'fam-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not be saved');
  });

  it('returns the number when the save landed', async () => {
    const res = await provisionFamilyNumber(admin([{ id: 'channel-1' }]), 'fam-1');
    expect(res).toEqual({ ok: true, phoneNumber: '+15550001111' });
  });
});
