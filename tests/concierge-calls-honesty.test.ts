// M26 honesty: the call queue never says Bubaly is calling or has called unless
// a provider outcome is persisted on the row.
//
// Bubaly has no outbound voice integration. The placement cron cannot dial, so
// no row ever carries `provider_ref`, and the only route to 'completed' is a
// parent logging what happened after making the call themselves. Every surface
// that talks about a call — the status pill, the stat tiles, the page copy, the
// find_vendor workflow's task notes and notification — must therefore say what
// the row persists and nothing more. This pins the vocabulary from four sides:
// the pure display-state function, the module that renders it, the cron that
// writes the row, and the workflow template that plans the repair.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALL_DISPLAY_LABEL, CALL_STATUS_LABEL, NO_PROVIDER_OUTCOME, callDisplayState, callDisplayTone, canLogOutcome, providerConfirmed,
  type CallStatus,
} from '@/lib/concierge-calls/brief';
import { instantiateTemplate, templateContextFrom, templateFor } from '@/lib/ai/planner/templates/index';
import { parseStepInput } from '@/lib/ai/planner/schema';
import { expectSays } from './helpers/translated';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const MODULE = 'components/modules/concierge-calls-module.tsx';
const PAGE = 'app/(app)/dashboard/concierge-calls/page.tsx';
const ROUTE = 'app/api/concierge-calls/place/route.ts';
const ACTIONS = 'app/(app)/dashboard/concierge-calls/actions.ts';

const STATUSES: CallStatus[] = ['draft', 'queued', 'calling', 'completed', 'failed', 'action_needed', 'cancelled'];

/** The words that claim a phone call happened or is happening. */
const CALL_CLAIM = /\bcalling\b|\bcalled\b/i;
/** The claims a workflow's copy could make about Bubaly doing the calling. */
const BUBALY_CALLS = /bubaly (is calling|will call|calls|called|has called|is dialing|will dial|dials|is placing|placed|places) /i;

function english(labelKey: string): string {
  const value = MESSAGES[labelKey];
  expect(value, `${labelKey} is in the catalogue`).toBeTruthy();
  return value;
}

describe('a call row says only what it persists', () => {
  it('never says calling or called while provider_ref is null, whatever the status', () => {
    for (const status of STATUSES) {
      const state = callDisplayState({ status, provider_ref: null });
      const { label, labelKey } = CALL_DISPLAY_LABEL[state];
      expect(label, `${status} without a provider → "${label}"`).not.toMatch(CALL_CLAIM);
      expect(english(labelKey), `${status} without a provider → catalogue`).not.toMatch(CALL_CLAIM);
      expect(state, status).not.toBe('calling');
      expect(state, status).not.toBe('called');
    }
    // An empty or whitespace provider_ref is not a confirmation either.
    for (const ref of ['', '   ']) {
      expect(providerConfirmed({ status: 'calling', provider_ref: ref })).toBe(false);
      expect(callDisplayState({ status: 'calling', provider_ref: ref })).toBe('queued');
    }
  });

  it('says calling and called only once a provider has written its call id onto the row', () => {
    expect(callDisplayState({ status: 'calling', provider_ref: 'CA123' })).toBe('calling');
    expect(CALL_DISPLAY_LABEL.calling.label).toBe('Calling…');
    expect(english(CALL_DISPLAY_LABEL.calling.labelKey)).toBe('Calling…');
    expect(callDisplayState({ status: 'completed', provider_ref: 'CA123' })).toBe('called');
    expect(english(CALL_DISPLAY_LABEL.called.labelKey)).toBe('Called');
    expect(callDisplayState({ status: 'action_needed', provider_ref: 'CA123' })).toBe('needs_you');
  });

  it('maps the states the queue can actually reach today to the honest vocabulary', () => {
    expect(callDisplayState({ status: 'queued', provider_ref: null })).toBe('queued');
    expect(english(CALL_DISPLAY_LABEL.queued.labelKey)).toBe('Queued for a call');
    // The cron marks a due call 'action_needed' with no provider: a person places it.
    expect(callDisplayState({ status: 'action_needed', provider_ref: null })).toBe('needs_person');
    expect(english(CALL_DISPLAY_LABEL.needs_person.labelKey)).toBe('Waiting for a person to call');
    // A parent logged the result by hand.
    expect(callDisplayState({ status: 'completed', provider_ref: null })).toBe('logged');
    expect(english(CALL_DISPLAY_LABEL.logged.labelKey)).toBe('Done — logged by hand');
    // Legacy rows the old cron flipped to 'calling' without dialing read as queued, not as a call in progress.
    expect(callDisplayState({ status: 'calling', provider_ref: null })).toBe('queued');
    expect(callDisplayTone('queued')).toBe('info');
    expect(callDisplayTone('needs_person')).toBe('warn');
    expect(callDisplayTone('logged')).toBe('success');
  });

  it('lets a person log the outcome from every state that is still waiting on a call', () => {
    expect(canLogOutcome('queued')).toBe(true);
    expect(canLogOutcome('needs_person')).toBe(true);
    expect(canLogOutcome('draft')).toBe(true);
    expect(canLogOutcome('failed')).toBe(true);
    for (const done of ['called', 'logged', 'calling', 'cancelled', 'needs_you'] as const) expect(canLogOutcome(done), done).toBe(false);
  });

  it('keeps the storage vocabulary separate from what a family sees', () => {
    // CALL_STATUS_LABEL is the raw column's label; it may say "Calling…" for
    // logs, which is exactly why the module is forbidden from rendering it.
    expect(CALL_STATUS_LABEL.calling).toBe('Calling…');
    const src = readFileSync(MODULE, 'utf8');
    expect(src).not.toMatch(/\bCALL_STATUS_LABEL\b/);
    expect(src).toMatch(/\bcallDisplayState\(/);
    expect(src).toMatch(/CALL_DISPLAY_LABEL\[state\]\.labelKey/);
  });
});

describe('the module and page make no claim the row cannot back', () => {
  const src = readFileSync(MODULE, 'utf8');
  const keys = [...src.matchAll(/\b(?:t|tr)\('([^']+)'\)/g)].map((m) => m[1]);

  it('resolves every catalogue key it renders', () => {
    expect(keys.length).toBeGreaterThan(20);
    const missing = keys.filter((k) => !(k in MESSAGES));
    expect(missing).toEqual([]);
  });

  it('renders no copy saying Bubaly makes, is making or will make the call', () => {
    const offenders = keys
      .map((k) => [k, MESSAGES[k]] as const)
      .filter(([, v]) => /bubaly (makes|will make|is making|makes) the call|bubaly calls|bubaly is calling|bubaly (will )?call\b|ask bubaly to (make|call)/i.test(v));
    expect(offenders).toEqual([]);
    // No hardcoded claim sneaks around the catalogue either.
    expect(src).not.toMatch(/>\s*Calling|Bubaly (is|will be) calling|Bubaly (makes|will make) the call/i);
  });

  it('tells the family a person places the call, in words a parent can act on', () => {
    expectSays(src, 'conciergeCallsModule.noPhoneProviderIsConnected', 'No phone provider is connected, so a parent places each call using the plan Bubaly writes.');
    expectSays(src, 'conciergeCalls.noPhoneProviderConnectedA', 'No phone provider connected — a parent places this call.');
    expectSays(src, 'conciergeCalls.saveTheCallPlan', 'Save the call plan');
    expectSays(src, 'conciergeCallsModule.callPlanSaved', 'Call plan saved.');
    // The honest state is actionable: a parent can record what happened.
    expect(src).toMatch(/logCallOutcomeAction\(/);
    expectSays(src, 'conciergeCalls.logWhatHappened', 'Log what happened');
  });

  it('has dropped the dishonest keys from every catalogue', () => {
    for (const key of ['conciergeCallsModule.bubalyMakesTheCallFor', 'conciergeCallsModule.onItBubalyWillMake', 'conciergeCallsModule.noCallsYetAskBubaly', 'conciergeCalls.askBubalyToCall', 'conciergeCalls.toAutoDial']) {
      expect(MESSAGES[key], key).toBeUndefined();
    }
  });

  it('keeps the list on screen when the realtime refresh fails, and fails the page closed', () => {
    expect(src).toMatch(/const \{ data, error \} = await supabase\.from\('concierge_calls'\)/);
    expect(src).toMatch(/console\.error\('\[concierge-calls\] refresh read failed'/);
    const page = readFileSync(PAGE, 'utf8');
    expect(page).toMatch(/const \{ data, error \} = await supabase/);
    expect(page).toMatch(/console\.error\('\[dashboard\/concierge-calls\] calls read failed'/);
    expectSays(page, 'conciergeCalls.couldNotLoadYourCallRequests', 'Could not load your call requests.');
    expect(page).toMatch(/<ErrorState /);
  });
});

describe('the placement cron writes only what it did', () => {
  const src = readFileSync(ROUTE, 'utf8');

  it("never writes status 'calling' without a provider_ref in the same update", () => {
    const writes = [...src.matchAll(/status:\s*'calling'/g)];
    for (const w of writes) {
      const window = src.slice(Math.max(0, w.index! - 200), w.index! + 300);
      expect(window, 'a calling write must carry provider_ref').toMatch(/provider_ref/);
    }
    // And, as of today, there is no dialer, so there is no such write at all.
    expect(writes).toHaveLength(0);
  });

  it('parks a due call with the persisted reason a person has to place it', () => {
    expect(src).toMatch(/status: 'action_needed', outcome: NO_PROVIDER_OUTCOME/);
    expect(NO_PROVIDER_OUTCOME).toBe('No phone provider connected — a parent places this call.');
    expect(src).toMatch(/providerReady: false/);
    expect(src).not.toMatch(/TWILIO_/);
  });

  it('logs and fails closed when the queue read fails', () => {
    expect(src).toMatch(/console\.error\('\[concierge-calls\/place\] queue read failed'/);
    expect(src).toMatch(/status: 500/);
  });
});

describe('a parent-logged outcome never masquerades as a provider outcome', () => {
  const src = readFileSync(ACTIONS, 'utf8');

  it('logCallOutcomeAction writes completed + outcome and never provider_ref', () => {
    const start = src.indexOf('export async function logCallOutcomeAction');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toMatch(/status: 'completed', outcome: text\.slice\(0, 2000\), completed_at/);
    expect(body).not.toMatch(/provider_ref/);
    // Family-scoped and manager-gated, like every other concierge mutation.
    expect(body).toMatch(/\.eq\('family_id', ctx\.active\.familyId\)/);
    expect(body).toMatch(/if \(!isManager\(ctx\.active\.role\)\) return \{ ok: false, error:/);
  });

  it('so the row a parent logged reads as logged by hand, not as called', () => {
    expect(callDisplayState({ status: 'completed', provider_ref: null })).toBe('logged');
  });
});

describe('the find_vendor workflow hands the call to a parent', () => {
  const ctx = templateContextFrom({
    tz: 'America/New_York', nowIso: '2026-09-05T16:00:00Z', todayKey: '2026-09-05',
    requestText: 'Our kitchen sink is leaking, find a plumber', viewerMemberId: 'mem-parent', managerIds: ['mem-parent'], trips: [],
  });
  const template = templateFor('find_vendor')!;
  const plan = instantiateTemplate(template, ctx);

  it('never writes that Bubaly is calling, will call or has called anyone', () => {
    const texts: string[] = [template.title, template.objective(ctx), ...template.guidance];
    for (const step of plan.steps) {
      texts.push(step.description ?? '');
      const input = parseStepInput(step.input);
      if (input.ok) texts.push(JSON.stringify(input.value));
    }
    const offenders = texts.filter((t) => BUBALY_CALLS.test(t));
    expect(offenders).toEqual([]);
  });

  it('names no tool that could dial, and asks a parent to make the call', () => {
    const tools = plan.steps.map((s) => s.tool_name).filter(Boolean) as string[];
    expect(tools.some((n) => /call|dial|phone|voice/i.test(n))).toBe(false);
    const task = plan.steps.find((s) => s.key === 'contact_task')!;
    const input = parseStepInput(task.input);
    expect(input.ok && String(input.value.notes)).toMatch(/A parent makes this call — Bubaly does not dial/);
    const tell = plan.steps.find((s) => s.key === 'tell_managers')!;
    const body = parseStepInput(tell.input);
    expect(body.ok && String(body.value.body)).toMatch(/waiting for a parent to make the call/);
  });
});
