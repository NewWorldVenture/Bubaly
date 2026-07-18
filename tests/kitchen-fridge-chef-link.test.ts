import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// PLA-0837: Fridge Chef (PLA-0835) must be discoverable — the Smart Kitchen
// header's quick-action row links to /dashboard/fridge-chef alongside Meal plan
// and Grocery. (The global app sidebar is intentionally untouched per the
// standing navigation rule.)
const kitchen = readFileSync('components/modules/kitchen-dashboard.tsx', 'utf8');

describe('Smart Kitchen links to Fridge Chef', () => {
  it('has a Fridge Chef quick action in the header row', () => {
    expect(kitchen).toContain('href="/dashboard/fridge-chef"');
    expect(kitchen).toContain('Fridge Chef');
  });

  it('keeps the existing Meal plan and Grocery quick actions', () => {
    expect(kitchen).toContain('href="/dashboard/meals"');
    expect(kitchen).toContain('href="/dashboard/grocery"');
  });
});
