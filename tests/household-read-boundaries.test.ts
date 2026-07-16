import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const decisionsSource = readFileSync('components/modules/decisions-module.tsx', 'utf8');
const visitsSource = readFileSync('components/modules/health-visits-module.tsx', 'utf8');
const announcementsSource = readFileSync('components/modules/announcements-module.tsx', 'utf8');
const contactsSource = readFileSync('components/modules/contacts-module.tsx', 'utf8');
const screenTimeSource = readFileSync('components/modules/screen-time-module.tsx', 'utf8');
const celebrationsSource = readFileSync('components/modules/celebrations-module.tsx', 'utf8');
const binderSource = readFileSync('components/modules/binder-module.tsx', 'utf8');
const graphSource = readFileSync('components/modules/graph-module.tsx', 'utf8');
const familyTreeSource = readFileSync('components/modules/family-tree-module.tsx', 'utf8');
const scorecardSource = readFileSync('components/modules/experience-scorecard-module.tsx', 'utf8');
const expensesSource = readFileSync('components/modules/expenses-module.tsx', 'utf8');
const insuranceSource = readFileSync('components/modules/insurance-module.tsx', 'utf8');
const lifeEventsSource = readFileSync('components/modules/life-events-module.tsx', 'utf8');
const planningSource = readFileSync('components/modules/planning-module.tsx', 'utf8');
const photosSource = readFileSync('components/modules/photos-module.tsx', 'utf8');
const petsSource = readFileSync('components/modules/pets-module.tsx', 'utf8');
const recipesSource = readFileSync('components/modules/recipes-module.tsx', 'utf8');
const remindersSource = readFileSync('components/modules/reminders-module.tsx', 'utf8');
const shoppingSource = readFileSync('components/modules/shopping-module.tsx', 'utf8');
const todosSource = readFileSync('components/modules/todos-module.tsx', 'utf8');
const utilitiesSource = readFileSync('components/modules/utilities-module.tsx', 'utf8');
const conciergeSource = readFileSync('components/modules/concierge-module.tsx', 'utf8');
const voiceSource = readFileSync('components/modules/voice-module.tsx', 'utf8');
const nextActionsSource = readFileSync('components/modules/next-actions-module.tsx', 'utf8');
const votingSource = readFileSync('components/modules/voting-module.tsx', 'utf8');
const weekendSource = readFileSync('components/modules/weekend-module.tsx', 'utf8');
const taxVaultSource = readFileSync('components/modules/tax-vault-module.tsx', 'utf8');
const subscriptionsSource = readFileSync('components/modules/subscriptions-module.tsx', 'utf8');
const tripMemoriesSource = readFileSync('components/modules/trip-memories-module.tsx', 'utf8');
const routinesSource = readFileSync('components/modules/routines-panel.tsx', 'utf8');

describe('household read boundaries', () => {
  it('coordinates decision and option failures before the Decision Engine empty state', () => {
    expect(decisionsSource).toContain('error: decisionsError, refresh: refreshDecisions');
    expect(decisionsSource).toContain('error: optionsError, refresh: refreshOptions');
    expect(decisionsSource).toContain('Could not load decision data. Refresh and try again.');
    expect(decisionsSource).toContain('void refreshDecisions(); void refreshOptions();');
  });

  it('surfaces health-visit read failures before the empty history state', () => {
    expect(visitsSource).toContain('error, refresh } = useRealtimeQuery');
    expect(visitsSource).toContain('Could not load health visits. Refresh and try again.');
    expect(visitsSource).toContain('onRetry={refresh}');
  });

  it('coordinates announcements and read receipts with one retry action', () => {
    expect(announcementsSource).toContain('error: announcementsError, refresh: refreshAnnouncements');
    expect(announcementsSource).toContain('error: readsError, refresh: refreshReads');
    expect(announcementsSource).toContain('void refreshAnnouncements(); void refreshReads();');
    expect(announcementsSource).toContain('Could not load announcements. Refresh and try again.');
  });

  it('surfaces contacts, screen-time, celebrations, and binder read failures', () => {
    expect(contactsSource).toContain('<ErrorState message={error} onRetry={refresh} />');
    expect(screenTimeSource).toContain('error: entriesError, refresh: refreshEntries');
    expect(screenTimeSource).toContain('error: limitsError, refresh: refreshLimits');
    expect(screenTimeSource).toContain('Could not load screen time data. Refresh and try again.');
    expect(celebrationsSource).toContain('Could not load celebrations. Refresh and try again.');
    expect(binderSource).toContain('Could not load household binder data. Refresh and try again.');
  });

  it('fails closed on graph, family-tree, scorecard, expense, insurance, and life-event reads', () => {
    expect(graphSource).toContain('error: entityError, refresh: refreshEntities');
    expect(graphSource).toContain('error: edgeError, refresh: refreshEdges');
    expect(graphSource).toContain('Could not load the knowledge graph. Refresh and try again.');
    expect(familyTreeSource).toContain('Could not load the family tree. Refresh and try again.');
    expect(scorecardSource).toContain('Could not load the experience scorecard. Refresh and try again.');
    expect(expensesSource).toContain('void refreshSplits(); void refreshShares();');
    expect(expensesSource).toContain('Could not load shared expenses. Refresh and try again.');
    expect(insuranceSource).toContain('onRetry={policies.refresh}');
    expect(lifeEventsSource).toContain('void refreshFacts(); void refreshPlans(); void refreshItems();');
    expect(lifeEventsSource).toContain('Could not load life and milestones data. Refresh and try again.');
  });

  it('fails closed on planning, media, pet, recipe, reminder, shopping, task, and utility reads', () => {
    expect(planningSource).toContain('void refreshPlans(); void refreshSteps();');
    expect(planningSource).toContain('Could not load prep plans. Refresh and try again.');
    expect(photosSource).toContain('Could not load family photos. Refresh and try again.');
    expect(petsSource).toContain('Could not load pet care data. Refresh and try again.');
    expect(recipesSource).toContain('Could not load family recipes. Refresh and try again.');
    expect(remindersSource).toContain('Could not load reminders. Refresh and try again.');
    expect(shoppingSource).toContain('Could not load shopping lists. Refresh and try again.');
    expect(todosSource).toContain('Could not load tasks. Refresh and try again.');
    expect(utilitiesSource).toContain('Could not load utility bills. Refresh and try again.');
  });

  it('fails closed on concierge, voice, next-action, voting, and weekend reads', () => {
    expect(conciergeSource).toContain('Could not load concierge plans. Refresh and try again.');
    expect(voiceSource).toContain('Could not load voice history. Refresh and try again.');
    expect(nextActionsSource).toContain('void refreshEvents(); void refreshTasks(); void refreshOpps();');
    expect(nextActionsSource).toContain('Could not load next actions. Refresh and try again.');
    expect(votingSource).toContain('void refreshPolls(); void refreshOptions(); void refreshVotes(); void refreshVacations(); void refreshBudgets();');
    expect(votingSource).toContain('Could not load family voting data. Refresh and try again.');
    expect(weekendSource).toContain('Could not load weekend planner data. Refresh and try again.');
  });

  it('fails closed on tax, subscription, trip-memory, and routine reads', () => {
    expect(taxVaultSource).toContain('Could not load tax documents. Refresh and try again.');
    expect(subscriptionsSource).toContain('Could not load subscriptions. Refresh and try again.');
    expect(tripMemoriesSource).toContain('void refreshMemories(); void refreshVacations();');
    expect(tripMemoriesSource).toContain('Could not load trip memories. Refresh and try again.');
    expect(routinesSource).toContain('Could not load routines. Refresh and try again.');
  });
});
