import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import fs from 'node:fs';

// A-14 §3e slice (agent-05, PLA-0799): two more marketplace surfaces conflated a
// failed read with "nothing here". The creator storefront `notFound()`-ed a real
// store on a transient read error (a permanent-gone 404), and the negotiations
// (offer) inbox rendered "No offers going yet" — a user with live money
// negotiations would think they have none. Both now distinguish error from absence.

const store = readUiSource('app/(app)/marketplace/creators/[id]/page.tsx');
const neg = readUiSource('app/(app)/marketplace/negotiations/page.tsx');

describe('marketplace storefront + negotiations surface a failed read (A-14 §3e)', () => {
  it('storefront throws on a real store read error and reserves notFound() for a missing store', () => {
    expect(store).toContain('data: store, error: storeError');
    expect(store).toContain('if (storeError) throw new Error(');
    expect(store.indexOf('if (storeError) throw')).toBeLessThan(store.indexOf('if (!store) notFound();'));
  });

  it('negotiations inbox returns a retryable ErrorState before the false-empty', () => {
    expect(neg).toContain('error: negError');
    expect(neg).toContain('if (negError)');
    expect(neg).toContain('<ErrorState message=');
    expect(neg.indexOf('if (negError)')).toBeLessThan(neg.indexOf('No offers going yet'));
  });
});
