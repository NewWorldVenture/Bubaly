import { describe, expect, it } from 'vitest';
import { analyzePets, buildPetsPrompt, parsePetsResponse, type PetForAI } from '@/lib/pets/pets-ai';

function pet(overrides: Partial<PetForAI> = {}): PetForAI {
  return { name: 'Buddy', species: 'dog', breed: 'Golden Retriever', birthday: '2020-06-15', ...overrides };
}

describe('analyzePets', () => {
  it('summarizes pets', () => {
    const r = analyzePets([pet(), pet({ species: 'cat', name: 'Whiskers' })]);
    expect(r.totalPets).toBe(2);
    expect(r.speciesCounts['dog']).toBe(1);
    expect(r.speciesCounts['cat']).toBe(1);
  });
  it('handles empty', () => {
    expect(analyzePets([]).summary).toContain('No pets');
  });
});

describe('buildPetsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildPetsPrompt([pet()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Buddy');
  });
});

describe('parsePetsResponse', () => {
  it('parses valid JSON', () => {
    const r = parsePetsResponse('{"suggestions":["regular checkups"],"careTips":["brush weekly"],"healthReminder":"annual vaccines"}');
    expect(r.suggestions).toEqual(['regular checkups']);
    expect(r.healthReminder).toBe('annual vaccines');
  });
  it('handles malformed', () => {
    expect(parsePetsResponse('bad').suggestions).toEqual([]);
  });
});
