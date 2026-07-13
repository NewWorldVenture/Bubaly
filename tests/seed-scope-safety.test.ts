import { afterEach, describe, expect, it } from 'vitest';
import { requireSeedScope } from '../scripts/seed-client.mjs';

const familyId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const seedKeys = ['SEED_ENVIRONMENT', 'SEED_FAMILY_ID', 'SEED_CONFIRM_FAMILY_ID', 'SEED_CREATED_BY_USER_ID'] as const;
const original = Object.fromEntries(seedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of seedKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function configure(environment = 'local', confirmedFamilyId = familyId) {
  process.env.SEED_ENVIRONMENT = environment;
  process.env.SEED_FAMILY_ID = familyId;
  process.env.SEED_CONFIRM_FAMILY_ID = confirmedFamilyId;
  process.env.SEED_CREATED_BY_USER_ID = userId;
}

describe('seed target safety', () => {
  it('requires an explicitly confirmed non-production target', () => {
    configure('production');
    expect(() => requireSeedScope()).toThrow(/production seeding is disabled/i);

    configure('preview', userId);
    expect(() => requireSeedScope()).toThrow(/must exactly match/i);
  });

  it('returns the confirmed scope for allowed environments', () => {
    configure('staging');
    expect(requireSeedScope()).toEqual({
      environment: 'staging',
      familyId,
      createdByUserId: userId,
    });
  });
});
