import { expect, test as base, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../lib/database.types';
import {
  authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

const enabled = process.env.E2E_DURABLE_SESSION === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
type MealFixture = {
  account: OwnedAccount;
  admin: SupabaseClient<Database>;
  mealId: string;
  recipeId: string;
  lunchId: string;
  monday: string;
  tuesday: string;
};

const test = base.extend<{ mealFixture: MealFixture }>({
  mealFixture: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const origin = requireLocalOrigin(provider);
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const account = await createOwnedAccount(origin, serviceKey);
    try {
      const admin = createClient<Database>(origin, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) },
      });
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
      const monday = start.toISOString().slice(0, 10);
      const tuesday = new Date(start.getTime() + 86_400_000).toISOString().slice(0, 10);
      const mealId = randomUUID(), recipeId = randomUUID(), lunchId = randomUUID();
      // Only fixture-owned household records are seeded, through disposable
      // local PostgREST. Every planned/created row below carries its owner ID.
      try {
        const meal = await admin.from('meals').insert({
          id: mealId, family_id: account.familyId, created_by: account.userId,
          name: 'Fixture roasted carrots', meal_type: 'lunch',
          ingredients: [{ name: 'carrots', qty: '2', unit: null }],
        });
        const recipe = await admin.from('family_recipes').insert({
          id: recipeId, family_id: account.familyId, created_by: account.userId,
          name: 'Fixture bean soup', category: 'dinner',
          ingredients: [{ name: 'beans', quantity: '1', unit: 'cup' }, { name: 'rice', quantity: '1/2', unit: 'cup' }],
          source_url: 'https://example.test/fixture-bean-soup',
        });
        const lunch = await admin.from('meal_plans').insert({
          id: lunchId, family_id: account.familyId, created_by: account.userId,
          meal_id: mealId, plan_date: monday, meal_type: 'lunch',
        });
        const pantry = await admin.from('pantry_items').insert({
          family_id: account.familyId, created_by: account.userId,
          name: 'beans', quantity: 0.1, unit: 'cup', location: 'pantry',
        });
        if (meal.error || recipe.error || lunch.error || pantry.error) throw new Error();
      } catch {
        throw new Error('Weekly meal E2E could not seed its owned disposable fixtures.');
      }
      await runFixture({ account, admin, mealId, recipeId, lunchId, monday, tuesday });
    } finally {
      // The shared helper deletes only this random family with its created_by
      // predicate (cascading these rows), then only this owned Auth user.
      await account.dispose();
    }
  },
});

test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

const dinner = (page: Page, day: 'Monday' | 'Tuesday') => page.getByRole('button', { name: new RegExp(`^Dinner for ${day}`) });
const dialog = (page: Page) => page.getByRole('dialog');

async function pickSaved(page: Page, day: 'Monday' | 'Tuesday', name: string) {
  await dinner(page, day).click();
  await dialog(page).getByRole('button', { name: new RegExp(name) }).click();
  await dialog(page).getByRole('button', { name: 'Save meal', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(dinner(page, day)).toContainText(name);
}

async function readPlans(fixture: MealFixture) {
  try {
    const { data, error } = await fixture.admin.from('meal_plans').select('id,meal_id,plan_date,meal_type')
      .eq('family_id', fixture.account.familyId).eq('created_by', fixture.account.userId);
    if (error || !data) throw new Error();
    return data;
  } catch { throw new Error('Weekly meal E2E could not read its owned persisted plan.'); }
}

async function readGroceries(fixture: MealFixture) {
  try {
    const { data, error } = await fixture.admin.from('grocery_items').select('id,name,quantity,source_meal_id')
      .eq('family_id', fixture.account.familyId).eq('created_by', fixture.account.userId).order('id');
    if (error || !data) throw new Error();
    return data;
  } catch { throw new Error('Weekly meal E2E could not read its owned persisted groceries.'); }
}

test.describe('weekly meal planner against disposable GoTrue and PostgREST', () => {
  test.skip(!enabled, 'Requires E2E_DURABLE_SESSION=1 and the disposable local Supabase.');
  test.setTimeout(120_000);

  test('saves recipes and custom ingredients, replaces one dinner, builds exact groceries, and removes only the selected plan', async ({ browser, baseURL, mealFixture }) => {
    const origin = requireLocalOrigin(baseURL);
    const { account, admin, mealId, recipeId, lunchId, monday, tuesday } = mealFixture;
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/login?redirect=/dashboard/meals`, { waitUntil: 'domcontentloaded' });
      try {
        await page.locator('input[name="email"]').fill(account.email);
        await page.locator('input[name="password"]').fill(account.password);
      } catch { throw new Error('Weekly meal E2E could not fill its sign-in form.'); }
      // Real password form, Next action, GoTrue verification and browser
      // adoption. No intercepted transport, injected cookies or mocked actions.
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(`${origin}/dashboard/meals`, { timeout: 60_000 });
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId, 'The browser must belong to the owned meal fixture').toBe(true);
      await expect(page.getByRole('heading', { name: 'Plan the week’s dinners', exact: true })).toBeVisible();

      await pickSaved(page, 'Monday', 'Fixture bean soup');
      const recipePlan = (await readPlans(mealFixture)).find(row => row.plan_date === monday && row.meal_type === 'dinner');
      expect(!!recipePlan?.meal_id, 'Recipe selection must persist a concrete meal ID').toBe(true);
      if (!recipePlan?.meal_id) throw new Error('Weekly meal E2E did not persist its recipe selection.');
      const recipeMeal = await admin.from('meals').select('ingredients,recipe_url').eq('family_id', account.familyId)
        .eq('created_by', account.userId).eq('id', recipePlan.meal_id).single();
      expect(!recipeMeal.error, 'The converted recipe must be readable').toBe(true);
      expect(recipeMeal.data).toEqual({
        ingredients: [{ name: 'beans', qty: '1', unit: 'cup' }, { name: 'rice', qty: '1/2', unit: 'cup' }],
        recipe_url: 'https://example.test/fixture-bean-soup',
      });
      const originalRecipe = await admin.from('family_recipes').select('id').eq('family_id', account.familyId)
        .eq('created_by', account.userId).eq('id', recipeId).single();
      expect(!!originalRecipe.data && !originalRecipe.error, 'Planning must preserve the saved recipe').toBe(true);

      await pickSaved(page, 'Tuesday', 'Fixture roasted carrots');
      const oldTuesday = (await readPlans(mealFixture)).find(row => row.plan_date === tuesday && row.meal_type === 'dinner');
      expect(oldTuesday?.meal_id).toBe(mealId);
      await dinner(page, 'Tuesday').click();
      await dialog(page).getByRole('button', { name: 'Create a meal', exact: true }).click();
      await dialog(page).getByRole('textbox', { name: /^Meal name/ }).fill('Fixture herbed beans');
      await dialog(page).getByRole('textbox', { name: 'Ingredient 1', exact: true }).fill('beans');
      await dialog(page).getByRole('textbox', { name: 'Quantity 1', exact: true }).fill('1');
      await dialog(page).getByRole('textbox', { name: 'Unit 1', exact: true }).fill('cup');
      await dialog(page).getByRole('button', { name: 'Add ingredient', exact: true }).click();
      await dialog(page).getByRole('textbox', { name: 'Ingredient 2', exact: true }).fill('basil');
      await dialog(page).getByRole('textbox', { name: 'Unit 2', exact: true }).fill('handful');
      await dialog(page).getByRole('button', { name: 'Save meal', exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(dinner(page, 'Tuesday')).toContainText('Fixture herbed beans');

      const plans = await readPlans(mealFixture);
      const tuesdayPlans = plans.filter(row => row.plan_date === tuesday && row.meal_type === 'dinner');
      expect(tuesdayPlans).toHaveLength(1);
      expect(tuesdayPlans[0].id).not.toBe(oldTuesday?.id);
      expect(plans.find(row => row.id === lunchId)?.meal_id).toBe(mealId);
      const customMeal = await admin.from('meals').select('ingredients').eq('family_id', account.familyId)
        .eq('created_by', account.userId).eq('id', tuesdayPlans[0].meal_id!).single();
      expect(!customMeal.error, 'The custom meal must be readable').toBe(true);
      expect(customMeal.data?.ingredients).toEqual([{ name: 'beans', qty: '1', unit: 'cup' }, { name: 'basil', qty: null, unit: 'handful' }]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(dinner(page, 'Monday')).toContainText('Fixture bean soup');
      await expect(dinner(page, 'Tuesday')).toContainText('Fixture herbed beans');
      await expect(page.getByRole('checkbox', { name: 'Skip ingredients already in pantry', exact: true })).not.toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The real phone planner must fit its viewport').toBe(true);
      await page.getByRole('button', { name: 'Add this week to the list', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Grocery List', exact: true })).toBeVisible();
      await expect(page.getByText('1 cup + 1 cup', { exact: true }).first()).toBeVisible();
      await expect.poll(async () => (await readGroceries(mealFixture)).length).toBe(4);
      const groceries = await readGroceries(mealFixture);
      expect(groceries.map(row => ({ name: row.name, quantity: row.quantity }))).toEqual(expect.arrayContaining([
        { name: 'beans', quantity: '1 cup + 1 cup' }, { name: 'rice', quantity: '1/2 cup' },
        { name: 'basil', quantity: 'handful' }, { name: 'carrots', quantity: '2' },
      ]));
      // A repeated request leaves existing list amounts intact and creates no
      // extra rows; it must not silently double the week's quantities.
      await page.getByRole('button', { name: 'Add this week to the list', exact: true }).click();
      await expect(page.getByText(/Already on the list.*4|4.*already on the list/i)).toBeVisible();
      expect(await readGroceries(mealFixture)).toEqual(groceries);

      await page.goto(`${origin}/dashboard/meals`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^Remove meal: Dinner, Monday/ }).click();
      await expect(dinner(page, 'Monday')).toContainText('Choose a meal');
      await expect.poll(async () => (await readPlans(mealFixture)).some(row => row.id === recipePlan.id)).toBe(false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(dinner(page, 'Monday')).toContainText('Choose a meal');
      await expect(dinner(page, 'Tuesday')).toContainText('Fixture herbed beans');
      const remaining = await readPlans(mealFixture);
      expect(remaining.map(row => row.id).sort()).toEqual([lunchId, tuesdayPlans[0].id].sort());
      const retainedMeal = await admin.from('meals').select('id').eq('family_id', account.familyId)
        .eq('created_by', account.userId).eq('id', mealId).single();
      expect(!!retainedMeal.data && !retainedMeal.error, 'Replacing/removing plans must preserve other library meals').toBe(true);
    } finally {
      // Close the custom pages/context before Playwright can attach an error
      // snapshot of a credential-bearing form. No storageState is ever written.
      await closeWithoutSnapshot(context);
    }
  });
});
