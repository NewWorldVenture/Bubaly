// The household's physical world: the home(s), the vehicles, the pets and the
// maintenance that is open. Identifiers are deliberately left out — a planner
// needs "the Honda" and "Biscuit the dog", never a VIN, a plate, a microchip
// id or a vet's phone number.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { listOpenMaintenance } from '@/lib/services/home';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { memberName, type SliceDefinition } from '../policy';
import { joinNatural, when } from '../render';

const MAX_ROWS = 10;
const MAX_MAINTENANCE = 20;

export type HomeSliceData = {
  homes: { id: string; name: string; type: string | null; isPrimary: boolean; hasAddress: boolean }[];
  vehicles: { id: string; label: string; year: number | null; primaryDriver: string | null; mileage: number | null }[];
  pets: { id: string; name: string; species: string; breed: string | null }[];
  maintenance: { id: string; title: string; dueAt: string | null; priority: string; assignee: string | null }[];
};

export const homeSlice: SliceDefinition = {
  name: 'home',
  title: 'Home, vehicles and pets',
  async load(scope, env) {
    const [homes, vehicles, pets, maintenance] = await Promise.all([
      scope.db.from('homes').select('id, name, home_type, is_primary, address').eq('family_id', scope.familyId).is('deleted_at', null).order('is_primary', { ascending: false }).limit(MAX_ROWS),
      scope.db.from('vehicles').select('id, nickname, make, model, year, primary_driver, mileage, status').eq('family_id', scope.familyId).is('deleted_at', null).limit(MAX_ROWS),
      scope.db.from('pets').select('id, name, species, breed').eq('family_id', scope.familyId).eq('is_active', true).limit(MAX_ROWS),
      listOpenMaintenance(scope, { limit: MAX_MAINTENANCE }),
    ]);
    const readError = homes.error ?? vehicles.error ?? pets.error;
    if (readError) {
      console.error('[ai-context:home] household read failed', readError);
      return fail(describeDbError(readError, 'Could not load the home details.'), { code: SERVICE_CODES.db });
    }
    if (!maintenance.ok) return maintenance;

    const data: HomeSliceData = {
      homes: (homes.data ?? []).map((h) => ({ id: h.id, name: h.name, type: h.home_type, isPrimary: h.is_primary, hasAddress: Boolean(h.address) })),
      vehicles: (vehicles.data ?? [])
        .filter((v) => v.status !== 'sold' && v.status !== 'retired')
        .map((v) => ({
          id: v.id,
          label: v.nickname ?? ([v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'),
          year: v.year,
          primaryDriver: memberName(env, v.primary_driver),
          mileage: v.mileage,
        })),
      pets: (pets.data ?? []).map((p) => ({ id: p.id, name: p.name, species: p.species, breed: p.breed })),
      maintenance: maintenance.data.map((m) => ({ id: m.id, title: m.title, dueAt: m.due_at, priority: m.priority, assignee: memberName(env, m.assignee_id) })),
    };

    const lines: string[] = [];
    for (const h of data.homes) {
      lines.push(`- Home: ${fenceUntrusted('home', h.name)}${h.type ? ` (${sanitizeUntrusted(h.type, 20)})` : ''}${h.isPrimary ? ', primary' : ''}${h.hasAddress ? ', address on file' : ''}`);
    }
    if (data.vehicles.length) {
      lines.push(`- Vehicles: ${joinNatural(data.vehicles.map((v) => `${v.year ? `${v.year} ` : ''}${fenceUntrusted('vehicle', v.label)}${v.primaryDriver ? ` (${v.primaryDriver})` : ''}`))}`);
    }
    if (data.pets.length) {
      lines.push(`- Pets: ${joinNatural(data.pets.map((p) => `${fenceUntrusted('pet', p.name)} the ${p.species.replace('_', ' ')}${p.breed ? ` (${fenceUntrusted('breed', p.breed)})` : ''}`))}`);
    }
    for (const m of data.maintenance) {
      const bits = [`- Maintenance: ${fenceUntrusted('maintenance', m.title)}`];
      if (m.dueAt) bits.push(Date.parse(m.dueAt) < env.now.getTime() ? `OVERDUE (${when(m.dueAt, env.tz, env.now)})` : `due ${when(m.dueAt, env.tz, env.now)}`);
      if (m.priority === 'high' || m.priority === 'urgent') bits.push(`[${m.priority}]`);
      if (m.assignee) bits.push(`(${m.assignee})`);
      lines.push(bits.join(' '));
    }
    if (!lines.length) lines.push('- No home, vehicle or pet details on file.');

    return ok({ data, count: data.homes.length + data.vehicles.length + data.pets.length + data.maintenance.length, lines });
  },
};
