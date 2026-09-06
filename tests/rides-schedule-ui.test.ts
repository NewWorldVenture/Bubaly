import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'family', userId: 'user', role: 'parent', members: [] }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: state.rows, loading: false, error: null }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => { throw new Error('Rendering must not write or request live records'); },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/app/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
}));

import { RidesModule } from '@/components/modules/rides-module';

function record(id: string, pickup: string, dropoff: string | null) {
  return {
    id, title: `Ride ${id}`, family_id: 'family', ride_date: '2099-06-22',
    pickup_time: pickup, dropoff_time: dropoff, driver_id: 'driver',
    rider_ids: [], status: 'planned', pickup_location: null, dropoff_location: null, notes: null,
  };
}

beforeEach(() => { state.rows = []; });

describe('rides screen recorded-time evidence', () => {
  it('feeds stored drop-off times into the rendered conflict warning', () => {
    state.rows = [record('a', '08:00', '09:00'), record('b', '08:30', '09:15')];
    const html = renderToStaticMarkup(createElement(RidesModule));
    expect(html).toContain('2 rides have a driver double-booked');
    expect((html.match(/>Conflict</g) ?? []).length).toBe(2);
    expect(html).toContain('Travel between rides is not assessed');
  });

  it('recomputes from changed saved rows without declaring travel feasibility', () => {
    state.rows = [record('a', '08:00', '08:30'), record('b', '08:30', '09:15')];
    const html = renderToStaticMarkup(createElement(RidesModule));
    expect(html).not.toContain('driver double-booked');
    expect(html).not.toContain('>Conflict<');
    expect(html).toContain('Travel between rides is not assessed');
  });

  it('displays unknown timing instead of treating a missing end as a clear schedule', () => {
    state.rows = [record('a', '08:00', null), record('b', '08:30', '09:15')];
    const html = renderToStaticMarkup(createElement(RidesModule));
    expect(html).toContain('1 ride has incomplete timing');
    expect(html).toContain('Timing incomplete');
    expect(html).not.toContain('driver double-booked');
    expect(html).toContain('cannot establish a clear schedule');
  });

  it('does not show past ride warnings in the upcoming view', () => {
    state.rows = [{ ...record('past', '08:00', null), ride_date: '2000-01-01' }, record('a', '09:00', '10:00')];
    const html = renderToStaticMarkup(createElement(RidesModule));
    expect(html).not.toContain('Timing incomplete');
    expect(html).not.toContain('Ride past');
  });
});
