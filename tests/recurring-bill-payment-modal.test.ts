import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Tables } from '@/lib/database.types';
import messages from '@/lib/i18n/messages/en-US.json';
import { BillPaymentModal } from '@/components/finance/bill-payment-modal';

vi.mock('@/components/i18n/use-format', () => ({ useFamilyClock: () => ({ todayKey: () => '2026-02-28' }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => messages[key as keyof typeof messages] ?? key }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ children }: { children: ReactNode }) => createElement('div', {}, children) }));

const bill = (over: Partial<Tables<'bills'>> = {}): Tables<'bills'> => ({
  id: 'bill-1', family_id: 'family-1', name: 'Synthetic rent', amount: 100, due_date: '2026-02-28',
  is_recurring: true, recurrence: 'monthly', due_day: null, status: 'upcoming', category: null,
  autopay: false, created_by: null, created_at: '', updated_at: '2026-01-01T00:00:00Z', ...over,
});
const render = (row: Tables<'bills'>) => renderToStaticMarkup(createElement(BillPaymentModal, { bill: row, familyId: 'family-1', onClose: () => {}, onDone: () => {} }));

describe('owner confirmation of an unknown recurring bill schedule', () => {
  it.each(['2026-02-28', '2026-03-28', '2026-03-29', '2026-03-30'])('leaves ambiguous legacy day %s unselected and requires a day before payment', (due_date) => {
    const html = render(bill({ due_date }));
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a day<\/option>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Mark paid<\/button>/);
    expect(html).toContain('value="31"');
    expect(html).not.toMatch(/value="28" selected/);
  });

  it('leaves a missing cadence unselected instead of guessing monthly', () => {
    const html = render(bill({ recurrence: null }));
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose a recurrence<\/option>/);
    expect(html).not.toContain('Day of month');
  });

  it('shows the persisted anchor when it is known', () => {
    expect(render(bill({ due_day: 31 }))).toMatch(/<option value="31" selected="">31<\/option>/);
  });
});
