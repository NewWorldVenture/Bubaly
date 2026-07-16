import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-12/A-06 safety authorization. `family_places` are the family geofences that
// drive arrival/departure alerts ("arrived at School"). Their RLS is family-scoped
// (`is_family_member` FOR ALL, migration 0042) and children have real logins, so
// editing/deleting/disabling a shared geofence must be manager-only — otherwise a
// child could silence the geofences watching them. Posting your OWN location and
// toggling your OWN sharing stay self-service. This test pins that split.
const SRC = 'app/(app)/dashboard/locator/actions.ts';

describe('A-12 shared family-place mutations require a manager', () => {
  const src = readFileSync(SRC, 'utf8');

  it('imports the manager role check', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bisManager\b[^}]*\}\s*from\s*'@\/lib\/constants\/roles'/);
  });

  for (const fn of ['savePlace', 'deletePlace', 'setGeofenceEnabled']) {
    it(`${fn} gates on isManager before touching family_places`, () => {
      const body = src.slice(src.indexOf(`export async function ${fn}(`));
      const scope = body.slice(0, body.indexOf('\nexport async function', 1) === -1 ? undefined : body.indexOf('\nexport async function', 1));
      expect(scope).toContain('if (!isManager(c.active.role)) return MANAGER_ONLY_PLACE;');
      expect(scope.indexOf('isManager')).toBeLessThan(scope.indexOf("from('family_places')"));
    });
  }

  it('self-only actions are NOT manager-gated (any member posts their own location / sharing)', () => {
    for (const fn of ['updateMyLocation', 'setLocationSharing']) {
      const body = src.slice(src.indexOf(`export async function ${fn}(`));
      const scope = body.slice(0, body.indexOf('\nexport async function', 1));
      expect(scope, `${fn} should stay self-service`).not.toContain('MANAGER_ONLY_PLACE');
    }
  });
});
