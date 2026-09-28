import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSavingsAnswer } from '@/components/modules/savings-coach-card';

// P-37 (finalaudit.md, page audit B15). A teen, a caregiver and a guest each
// pressed "Analyze my finances" on /dashboard/subscriptions. The route refused
// them with 403 { error: "Family finances are private to the adults…" }, as
// API-SWEEP-05 made it, and the card showed nothing at all: it read only
// `summary` and `suggestions`. An engine that is not set up (503) was silent
// the same way.
const FALLBACK = 'Recommendations are temporarily unavailable.';

describe('readSavingsAnswer', () => {
  it('shows the route\'s own refusal, in the reader\'s language', () => {
    expect(readSavingsAnswer(false, { error: 'Les finances de la famille sont réservées aux adultes.' }, FALLBACK))
      .toEqual({ summary: '', suggestions: [], error: 'Les finances de la famille sont réservées aux adultes.' });
  });
  it('says something when a failure carries no message', () => {
    expect(readSavingsAnswer(false, null, FALLBACK).error).toBe(FALLBACK);
    expect(readSavingsAnswer(false, { error: '' }, FALLBACK).error).toBe(FALLBACK);
    expect(readSavingsAnswer(false, 'upstream html', FALLBACK).error).toBe(FALLBACK);
  });
  it('passes a real answer through, with no error', () => {
    const tip = { title: 'Pause the gym', detail: 'Unused for 60 days.' };
    expect(readSavingsAnswer(true, { summary: 'Two to review.', suggestions: [tip] }, FALLBACK))
      .toEqual({ summary: 'Two to review.', suggestions: [tip], error: null });
    expect(readSavingsAnswer(true, { summary: 7, suggestions: 'x' }, FALLBACK))
      .toEqual({ summary: '', suggestions: [], error: null });
  });
});

describe('the card', () => {
  const src = readFileSync('components/modules/savings-coach-card.tsx', 'utf8');
  it('renders the error where the reader is looking, as an alert', () => {
    expect(src).toMatch(/state\.error && <p role="alert"/);
  });
  it('has no English-only fallback left', () => {
    expect(src).not.toMatch(/'Could not generate suggestions right now\.'/);
  });
});
