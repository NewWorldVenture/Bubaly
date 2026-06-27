// Ready-made Website Template starting points. Picking one pre-fills the editor
// with complete, SEO-strong copy for a topic so a marketer can launch in seconds.
// All copy uses {state} (+ {state_abbr}/{state_slug}/{year}/{product}) so it works
// across every state out of the box.
import type { FeatureBlock, FaqItem } from '@/lib/seo/template';

export type SeoPreset = {
  id: string;
  label: string;
  description: string;
  draft: {
    name: string;
    topic: string;
    slugPattern: string;
    eyebrow: string;
    h1Template: string;
    subheadTemplate: string;
    metaTitleTemplate: string;
    metaDescriptionTemplate: string;
    introTemplate: string;
    featureBlocks: FeatureBlock[];
    faqs: FaqItem[];
    ctaLabel: string;
    ctaHref: string;
    staticVars: Record<string, string>;
  };
};

const BUBALY: Record<string, string> = { product: 'Bubaly' };

export const SEO_PRESETS: SeoPreset[] = [
  {
    id: 'family-organizer',
    label: 'Family Organizer',
    description: 'The all-in-one family app — calendars, chores, meals, reminders.',
    draft: {
      name: 'Family Organizer by State',
      topic: 'family-organizer',
      slugPattern: 'family-organizer/{state_slug}',
      eyebrow: '{product} · {state}',
      h1Template: 'The #1 Family Organizer App in {state}',
      subheadTemplate: 'Join {state} families staying organized with {product} — calendars, chores, meals, and more in one app.',
      metaTitleTemplate: '{product} for {state} Families | Family Organizer App',
      metaDescriptionTemplate: 'The best family organizer app for {state} households in {year}. Shared calendars, chores, meal planning, and reminders — all in one place.',
      introTemplate: 'Families across {state} use {product} to keep everyone on the same page.\n\nFrom shared calendars to chores, meal planning, and reminders — {product} brings your whole household together in one beautifully simple app.',
      featureBlocks: [
        { icon: 'calendar', title: 'Shared family calendar', description: 'Everyone in your {state} household sees the same schedule in real time.' },
        { icon: 'chores', title: 'Chores & rewards', description: 'Assign chores and motivate kids with points and allowances.' },
        { icon: 'meals', title: 'Meal planning', description: 'Plan the week and build grocery lists automatically.' },
      ],
      faqs: [
        { q: 'Is {product} available in {state}?', a: 'Yes — {product} works for every family in {state} and across the U.S.' },
        { q: 'How much does {product} cost?', a: '{product} has a free plan, plus affordable Basic and Plus tiers for families who want more.' },
      ],
      ctaLabel: 'Get started free',
      ctaHref: '/signup',
      staticVars: BUBALY,
    },
  },
  {
    id: 'chore-allowance',
    label: 'Chore & Allowance App',
    description: 'Chore charts, points, and allowances that motivate kids.',
    draft: {
      name: 'Chore & Allowance App by State',
      topic: 'chore-app',
      slugPattern: 'chore-app/{state_slug}',
      eyebrow: '{product} · {state}',
      h1Template: 'The Best Chore & Allowance App for {state} Families',
      subheadTemplate: 'Motivate kids in {state} with chore charts, points, and automatic allowances — all in {product}.',
      metaTitleTemplate: 'Chore & Allowance App for {state} Kids | {product}',
      metaDescriptionTemplate: 'Assign chores, track points, and pay allowances automatically. The top chore app for {state} families in {year}.',
      introTemplate: 'Tired of nagging? {state} parents use {product} to turn chores into a game kids actually want to play.\n\nAssign tasks, set point values, and let allowances pay out automatically when chores are done.',
      featureBlocks: [
        { icon: 'chores', title: 'Visual chore charts', description: 'Age-appropriate chores your {state} kids can check off themselves.' },
        { icon: 'wallet', title: 'Automatic allowances', description: 'Points convert to allowance and pay out on your schedule.' },
        { icon: 'star', title: 'Rewards & streaks', description: 'Streaks and rewards keep kids motivated week after week.' },
      ],
      faqs: [
        { q: 'What age is the {product} chore app for?', a: '{product} works for toddlers to teens — chores and rewards scale with each child.' },
        { q: 'Can allowances pay out automatically?', a: 'Yes. Set a weekly amount and {product} pays it into each child’s wallet when chores are complete.' },
      ],
      ctaLabel: 'Start free',
      ctaHref: '/signup',
      staticVars: BUBALY,
    },
  },
  {
    id: 'meal-planner',
    label: 'Meal Planner & Groceries',
    description: 'Weekly meal plans with auto-built grocery lists.',
    draft: {
      name: 'Meal Planner by State',
      topic: 'meal-planner',
      slugPattern: 'meal-planner/{state_slug}',
      eyebrow: '{product} · {state}',
      h1Template: 'The Easiest Family Meal Planner in {state}',
      subheadTemplate: 'Plan a week of dinners and build the grocery list in seconds — {product} makes mealtime simple for {state} families.',
      metaTitleTemplate: 'Family Meal Planner for {state} | {product}',
      metaDescriptionTemplate: 'Plan weekly meals, save favorite recipes, and auto-build grocery lists. The best meal planning app for {state} families in {year}.',
      introTemplate: '“What’s for dinner?” — answered. {state} families use {product} to plan the week and shop in one tap.\n\nSave recipes, drag meals onto the calendar, and {product} builds the grocery list for you.',
      featureBlocks: [
        { icon: 'meals', title: 'Drag-and-drop meal plan', description: 'Plan the week your {state} family will actually eat.' },
        { icon: 'cart', title: 'Auto grocery lists', description: 'Every planned meal adds its ingredients to your list automatically.' },
        { icon: 'recipes', title: 'Recipe box', description: 'Save and reuse your family’s favorite recipes.' },
      ],
      faqs: [
        { q: 'Does {product} build a grocery list automatically?', a: 'Yes — planning a meal adds its ingredients to a smart, de-duplicated shopping list.' },
        { q: 'Can the whole family see the meal plan?', a: 'Everyone in your {state} household sees the same plan and list in real time.' },
      ],
      ctaLabel: 'Plan your week free',
      ctaHref: '/signup',
      staticVars: BUBALY,
    },
  },
  {
    id: 'shared-calendar',
    label: 'Shared Family Calendar',
    description: 'One calendar for the whole household, synced everywhere.',
    draft: {
      name: 'Shared Family Calendar by State',
      topic: 'family-calendar',
      slugPattern: 'family-calendar/{state_slug}',
      eyebrow: '{product} · {state}',
      h1Template: 'The Shared Family Calendar {state} Parents Love',
      subheadTemplate: 'Keep every appointment, practice, and pickup in sync — one calendar for your whole {state} family.',
      metaTitleTemplate: 'Shared Family Calendar for {state} | {product}',
      metaDescriptionTemplate: 'One color-coded calendar the whole family shares, synced across phones. The best shared family calendar for {state} in {year}.',
      introTemplate: 'Stop juggling five calendars. {state} families use {product} to see everyone’s schedule in one place.\n\nColor-coded per person, synced across every phone, with reminders so nothing slips.',
      featureBlocks: [
        { icon: 'calendar', title: 'Everyone in one view', description: 'Color-coded schedules for each member of your {state} family.' },
        { icon: 'bell', title: 'Smart reminders', description: 'Automatic nudges so no practice or appointment is missed.' },
        { icon: 'users', title: 'Syncs everywhere', description: 'Works alongside Google and Apple calendars on every device.' },
      ],
      faqs: [
        { q: 'Does {product} sync with Google Calendar?', a: 'Yes — {product} syncs with Google and Apple calendars two ways.' },
        { q: 'Can grandparents and sitters see the calendar?', a: 'You control sharing — invite anyone in {state} to the views you choose.' },
      ],
      ctaLabel: 'Get your family calendar',
      ctaHref: '/signup',
      staticVars: BUBALY,
    },
  },
];
