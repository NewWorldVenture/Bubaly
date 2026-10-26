import { describe, expect, it } from 'vitest';
import { isSensitiveMemory } from '@/lib/services/memory';

/**
 * A SENSITIVE MEMORY IS CAUGHT IN EVERY FORM OF ITS WORD (AI-001).
 *
 * `isSensitiveMemory` is one rule with many consumers: it is what stops the
 * assistant learning health or credential detail from a chat, and what hides
 * such a fact from a child in recall (`filterVisibleMemories`), search, the
 * prompt's memory slice, insights and the AI settings page.
 *
 * Its term list matched WHOLE words, and three entries were stems that can
 * never be a whole word — `diagnos`, `therap`, `pregnan`: there is no word
 * boundary inside "diagnosed", "therapist" or "pregnant". Others were singular
 * only. So "Sam was diagnosed with ADHD", "Mom is pregnant", "Dana sees a
 * therapist" and "Two prescriptions to refill" were not sensitive: the
 * assistant could file them as ordinary memories, and a child was shown them.
 */
describe('isSensitiveMemory reads every form of a sensitive word', () => {
  it.each([
    'Sam was diagnosed with ADHD',
    'Diagnosis: type 1 diabetes',
    'Waiting on the diagnostic results',
    'Mom is pregnant',
    'Pregnancy due date is March 3',
    'Dana sees a therapist on Tuesdays',
    'Family therapy every other week',
    'Takes medications at 8am',
    'Two prescriptions to refill',
    'Prescribed antibiotics on Monday',
    'Our passwords are on the fridge',
    'The wifi passcodes',
    'Salaries land on the 1st',
    'Both banks close at 4',
    'Account numbers are in the binder',
    // Already caught before, and must stay caught.
    'Allergic to peanuts',
    'Takes medication at night',
    'Bank of America',
  ])('%j is sensitive', (content) => {
    expect(isSensitiveMemory({ category: 'general', key: 'note', content })).toBe(true);
  });

  it.each([
    'Soccer practice on Tuesdays',
    "Grandma's birthday is June 4",
    'Sam likes spicy food',
    'The Pinterest board for the party',
    'Pick-up is at the north gate',
  ])('%j is an ordinary memory', (content) => {
    expect(isSensitiveMemory({ category: 'general', key: 'note', content })).toBe(false);
  });

  it('reads the key and the notes as well as the content', () => {
    expect(isSensitiveMemory({ category: 'general', key: 'Diagnosis', content: 'ADHD' })).toBe(true);
    expect(isSensitiveMemory({ category: 'general', key: 'note', content: 'see below', notes: 'She is pregnant' })).toBe(true);
  });
});
