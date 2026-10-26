// The Maintenance page offered "Schedule recommended maintenance" to everyone.
//
// The action behind the button (`scheduleRecommendedTasksAction`) now refuses
// anyone but a parent or adult, as the Home page's "Add task" does, but the
// Maintenance page still showed the button to a child, teen, caregiver or
// guest, who could only press it to be told no. The page now shows it under
// the same rule as the action.
import { describe, expect, it, vi } from 'vitest';
import { renderServerPage, textOf } from './helpers/render-server-page';

const boundary = vi.hoisted(() => ({ role: 'parent' }));
vi.mock('@/lib/supabase/auth', () => ({
  requirePlanLevel: async () => ({
    user: { id: 'auth-1' },
    active: { familyId: 'fam-1', role: boundary.role, family: { timezone: 'America/New_York' } },
  }),
  requireUserContext: async () => { throw new Error('not used'); },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => { throw new Error('not used'); } }));
vi.mock('@/lib/home/queries', () => ({
  getAssets: async () => [
    { id: 'furnace', family_id: 'fam-1', name: 'Furnace', category: 'furnace', install_date: null, purchase_date: null, last_serviced_on: '2026-01-10', expected_life_years: null },
    { id: 'lamp', family_id: 'fam-1', name: 'Lamp', category: 'other', install_date: null, purchase_date: null, last_serviced_on: null, expected_life_years: null },
  ],
}));
const { default: MaintenancePage } = await import('@/app/(app)/dashboard/home/maintenance/page');

const SCHEDULE = 'Schedule recommended maintenance';

async function pageFor(role: string): Promise<string> {
  boundary.role = role;
  return textOf(await renderServerPage(await MaintenancePage()));
}

describe('the Maintenance page', () => {
  for (const role of ['parent', 'adult']) {
    it(`offers a ${role} the recommended schedule`, async () => {
      const text = await pageFor(role);
      expect(text).toContain('Furnace');
      expect(text).toContain(SCHEDULE);
    });
  }

  for (const role of ['child', 'teen', 'caregiver', 'guest']) {
    it(`does not offer a ${role} what the action refuses them`, async () => {
      const text = await pageFor(role);
      expect(text).toContain('Furnace');
      expect(text).not.toContain(SCHEDULE);
    });
  }
});
