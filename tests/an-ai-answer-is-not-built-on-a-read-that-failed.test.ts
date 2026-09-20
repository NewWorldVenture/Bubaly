import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

/**
 * Line comments only — enough to stop an assertion matching the prose that
 * explains the very thing it forbids, without pulling in a parser.
 */
function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Audit C1-S9-25 — two AI routes that answered a family's question at HTTP 200
 * from reads that had not happened.
 *
 * Reported by a parallel worker sweeping the API surface, then re-verified in
 * source before either was touched.
 */
const savings = readFileSync('app/api/ai/savings/route.ts', 'utf8');
const habits = readFileSync('app/api/ai/habits/route.ts', 'utf8');

describe('the savings route does not answer "On track" from a failed read (C1-S9-25)', () => {
  it('checks all four finance reads and refuses rather than reassures', () => {
    // Its own docstring says it "never fabricates numbers" — and it did: a
    // refused `transactions` read emptied the category map, produced no
    // overspending, and reached the deterministic "On track" fallback at 200.
    expect(savings).toContain('const readFailures = (');
    for (const label of ['transactions', 'budgets', 'bills', 'subscriptions']) {
      expect(savings, `${label} must be named in the failure list`).toContain(`['${label}',`);
    }
    expect(savings).toContain('{ status: 503 }');
    // The bail must precede the work it invalidates: the category map, the
    // model context, and the fallback.
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, 'const byCat'));
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, "title: 'On track'"));
  });

  it('bounds the transactions read for real, not with .limit()', () => {
    // `.limit(N)` is not a bound — PostgREST caps at db-max-rows regardless —
    // so an understated over-budget figure would still be stated as fact.
    const read = bodyOf(savings, 'const [txnsResult', ']);');
    expect(read).toContain('readAllAsQuery');
    expect(read).toContain('{ max: 20_000 }');
    expect(read).not.toMatch(/from\('transactions'\)[\s\S]{0,200}?\.limit\(/);
  });
});

describe('the habits route does not compute streaks from a prefix (C1-S9-25)', () => {
  it('checks both reads, including readAll\'s truncation signal', () => {
    // readAll sets `error` for a failed page AND for exceeding `max`, handing
    // back partial rows either way. Dropping it meant "current streak 0" to
    // someone who had not missed a day.
    expect(habits).toMatch(/const \{ rows: logs, error: logsError \}/);
    expect(habits).toMatch(/const \{ data: habits, error: habitsError \}/);
    expect(habits).toContain('if (habitsError || logsError)');
    expect(habits).toContain('{ status: 503 }');
    // Before the streak maths, not after it.
    expect(at(habits, 'if (habitsError || logsError)')).toBeLessThan(at(habits, 'const logsByHabit'));
  });

  it('keeps the real ceiling the earlier fix installed', () => {
    // The `.limit(5000)` that was never 5,000 must not come back.
    expect(habits).toContain('{ max: 5000 }');
    expect(habits).not.toMatch(/from\('habit_logs'\)[\s\S]{0,200}?\.limit\(/);
  });
});

/**
 * Audit C1-S9-37 — the rest of the class, from a sweep of all 146 API routes.
 *
 * The scan looked for `const { data } = await ...` (the error dropped) whose
 * binding then reaches a `?? []` / `?? 0` fallback. Four survived, all of them
 * AI routes, and the sweep is recorded as a bound rather than a sample: 146
 * routes scanned, 46 data-only destructures, 4 with an empty-value fallback.
 */
const nutrition = readFileSync('app/api/ai/meals/nutrition/route.ts', 'utf8');
const relationship = readFileSync('app/api/ai/relationship/route.ts', 'utf8');
const journal = readFileSync('app/api/ai/journal/route.ts', 'utf8');
const utility = readFileSync('app/api/ai/home/utility-savings/route.ts', 'utf8');

describe('nutrition is not estimated for meals the route could not name (C1-S9-37)', () => {
  it('both week reads refuse rather than guess', () => {
    expect(nutrition).toContain('if (plansResult.error)');
    expect(nutrition).toContain('if (mealsResult.error)');
    // Scoped, not counted file-wide: this route already had two unrelated 503s
    // (AI unconfigured, and a provider failure), so a raw count asserts nothing.
    for (const guard of ['if (plansResult.error)', 'if (mealsResult.error)']) {
      // `bodyOf` asserts the end token appears AFTER the guard, so reaching the
      // 503 from each guard is the assertion; `'}'` alone would have stopped at
      // the console.error object's own closing brace.
      const bail = bodyOf(nutrition, guard, '{ status: 503 });');
      expect(bail, guard).toContain('ai.recommendationsAreTemporarilyUnavailable');
    }
    // Before the prompt is built, not after.
    expect(at(nutrition, 'if (mealsResult.error)')).toBeLessThan(at(nutrition, 'Estimate the AVERAGE PER DAY'));
  });

  it('the filter that only looked like a filter is gone', () => {
    // `.filter((l) => l.label !== 'meal' || true)` is unconditionally true. It
    // kept every line while reading as though it dropped the unresolved ones, so
    // a failed `meals` read sent twenty-one lines of "- <date> dinner: meal" to
    // the model and got back per-day macros for a week it had never seen.
    // Asserted against the code with comments stripped: the explanatory comment
    // below QUOTES the old expression, and a file-wide `not.toContain` matched
    // its own documentation. Same trap as C1-S9-34, from the other direction —
    // there a comment kept a guard green, here it turned one red.
    const code = stripComments(nutrition);
    expect(code).not.toContain('|| true');
    expect(code).not.toContain("?? 'meal'");
    // And the intent it described is now actually implemented.
    expect(nutrition).toContain('return label ? [{ label, date: p.plan_date, meal_type: p.meal_type }] : [];');
  });

  it('"not found" means the database answered, for the recipe and the meal', () => {
    // These two were missed by the first sweep, whose heuristic required a
    // `?? []` fallback within twelve lines. They have none: a refused read left
    // the binding null and fell straight into a 404, telling a family their own
    // recipe does not exist. 404 is a statement about their data.
    for (const guard of ['if (recipeError)', 'if (mealError)']) {
      expect(nutrition, guard).toContain(guard);
      expect(bodyOf(nutrition, guard, '{ status: 503 });'), guard)
        .toContain('ai.recommendationsAreTemporarilyUnavailable');
    }
    // And the genuine 404s are kept, because they are right for a real absence.
    expect(nutrition).toContain("t('nutrition.recipeNotFound')");
    expect(nutrition).toContain("t('nutrition.mealNotFound')");
    expect(at(nutrition, 'if (recipeError)')).toBeLessThan(at(nutrition, "t('nutrition.recipeNotFound')"));
    expect(at(nutrition, 'if (mealError)')).toBeLessThan(at(nutrition, "t('nutrition.mealNotFound')"));
  });

  it('the cache read degrades deliberately rather than silently', () => {
    // The one read here where continuing is correct — the recomputed answer is
    // right, it just costs a model call. Recorded so the decision is visible.
    expect(nutrition).toContain('if (cacheError)');
    expect(bodyOf(nutrition, 'if (cacheError)', '});')).toContain('console.warn');
    expect(nutrition).not.toMatch(/if \(cacheError\)[\s\S]{0,200}?status: 50/);
  });

  it('an unnameable week is refused, not fabricated', () => {
    // The pre-existing 422 is the truthful answer when nothing can be named.
    expect(nutrition).toMatch(/if \(lines\.length === 0\)[\s\S]{0,160}?status: 422/);
  });
});

describe('a relationship digest is not built on reads that failed (C1-S9-37)', () => {
  it('the dates guard is no longer inverted with respect to risk', () => {
    // It caught `isMissingRelationError` — "this feature is not installed yet" —
    // and let every REAL error through to `dateRows ?? []`. A helper whose whole
    // job is not forgetting the anniversary then reported ninety clear days.
    expect(relationship).toContain('if (datesErr || profileErr)');
    expect(at(relationship, 'if (datesErr || profileErr)')).toBeLessThan(at(relationship, 'const dates: RelDate[]'));
    // The missing-relation branch is KEPT: it is a different answer, and it was
    // right about the case it covered.
    expect(relationship).toContain('if (datesErr && isMissingRelationError(datesErr))');
  });

  it('the profile behind every personal detail is checked', () => {
    expect(relationship).toContain('error: profileErr');
  });

  it('the wishlist that grounds the gift suggestions is checked', () => {
    const block = bodyOf(relationship, "const { data: items, error: itemsError }", '{ status: 503 });');
    expect(block).toContain('if (itemsError)');
    // Against the CALL, not the import at the top of the file, which is what a
    // bare `at()` on the symbol finds.
    expect(at(relationship, 'if (itemsError)')).toBeLessThan(at(relationship, 'buildRelationshipDigestPrompt({'));
  });
});

describe('a journal prompt is honest about being generic (C1-S9-37)', () => {
  it('a failed read takes the evergreen path rather than posing as personal', () => {
    // An empty list is also what a brand-new journal produces, so the route
    // returned a generic prompt labelled `source: 'ai'`. The evergreen fallback
    // already existed for this and says what it is.
    expect(journal).toContain('if (recentError)');
    // Anchored to the block's OWN closing brace. A `bodyOf(..., "source:
    // 'evergreen' });")` slice passed while the bail returned something else
    // entirely, because `bodyOf` searches forward and found the route's other,
    // pre-existing evergreen return further down — the empty-slice hazard's
    // sibling: a slice that is too LONG rather than too short.
    expect(journal).toMatch(
      /if \(recentError\) \{[\s\S]{0,300}?return NextResponse\.json\(\{ prompt: promptOfTheDay\(\), source: 'evergreen' \}\);\s*\}/,
    );
    expect(at(journal, 'if (recentError)')).toBeLessThan(at(journal, 'const snippets'));
  });
});

describe('utility savings does not ask for bills it failed to read (C1-S9-37)', () => {
  it('a refused read is not "add a few utility bills"', () => {
    expect(utility).toContain('if (billsError)');
    expect(utility).toContain('{ status: 503 }');
    // The empty-bills 400 is kept — it is correct for a family with no bills.
    expect(utility).toContain("t('utilitySavings.addAFewUtilityBills')");
    expect(at(utility, 'if (billsError)')).toBeLessThan(at(utility, "t('utilitySavings.addAFewUtilityBills')"));
  });
});

describe('the sweep that found these leaves nothing behind (C1-S9-37)', () => {
  it('no AI route still drops a read error into an empty-value fallback', () => {
    for (const [name, source] of [
      ['nutrition', nutrition], ['relationship', relationship],
      ['journal', journal], ['utility-savings', utility],
    ] as const) {
      // The exact shape the scan matched: only `data` destructured off an await.
      const dropped = stripComments(source).match(/const \{ data(?:: \w+)? \} = await/g) ?? [];
      expect(dropped, `${name} still has a read with its error dropped`).toHaveLength(0);
    }
  });
});

/**
 * Audit C1-S9-38 — the "dropped error → not found" bucket from the C1-S9-37
 * inventory, plus the one read in a cron recovery path.
 *
 * All five of these already failed CLOSED, so none was a bypass. What each got
 * wrong was WHICH closed answer it gave: a refused read produced "your recipe
 * does not exist", "trip not found", "this form is no longer available". Those
 * are claims about the caller's data, and they have to come from an answer.
 */
const notFoundRoutes = [
  ['ai/wallet/child', 'app/api/ai/wallet/child/[childId]/route.ts', 'cwError', 'child.childWalletNotFound'],
  ['email/invite', 'app/api/email/invite/route.ts', 'inviteError', 'invite.inviteNotFound'],
  ['forms/submit', 'app/api/forms/submit/route.ts', 'formError', 'submit.thisFormIsNoLonger'],
  ['recipes/transform', 'app/api/recipes/transform/route.ts', 'recipeError', 'transform.recipeNotFound'],
  ['vacations/weather', 'app/api/vacations/weather/route.ts', 'tripError', 'weather.tripNotFound'],
] as const;

describe('a refused read is not "not found" (C1-S9-38)', () => {
  it.each(notFoundRoutes)('%s distinguishes a refusal from an absence', (_name, file, binding, notFoundKey) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(`error: ${binding}`);
    expect(source).toContain(`if (${binding})`);
    expect(bodyOf(source, `if (${binding})`, '{ status: 503 }')).toContain('console.error');
    // The 404 is KEPT — it is the right answer for a row that really is gone.
    expect(source).toContain(notFoundKey);
    expect(at(source, `if (${binding})`)).toBeLessThan(at(source, notFoundKey));
  });

  it('the invite route uses maybeSingle, or the fix would invert itself', () => {
    // `.single()` makes a MISSING ROW an error (PGRST116). Checking the error
    // first and keeping `.single()` would have turned every genuine 404 into a
    // 503 — the new guard breaking the case the old code got right by accident.
    // `.maybeSingle()` is what makes "absent" and "refused" separable at all.
    const source = readFileSync('app/api/email/invite/route.ts', 'utf8');
    expect(source).toContain('.maybeSingle()');
    expect(bodyOf(source, "from('invites')", '.maybeSingle();')).not.toContain('.single()');
  });
});

describe('a cron recovery path says when it could not run (C1-S9-38)', () => {
  const cron = readFileSync('app/api/cron/family-routines/route.ts', 'utf8');

  it('the reservation read is checked, not silently treated as nothing-to-do', () => {
    // Every WRITE in this function already checked its error. The read that
    // decides whether the recovery runs at all did not: a refusal left
    // `reservation` null and took the same early return as "nothing to release",
    // so the rule stayed wedged on one due_at, came back every tick, and nothing
    // said so — the function exited down its success path.
    const body = bodyOf(cron, 'async function releaseWedgedOccurrence', '\n}');
    expect(body).toContain('error: reservationError');
    expect(body).toContain('if (reservationError)');
    expect(body).toContain('rule stays wedged');
    // Before the early return that a null reservation would take.
    expect(at(body, 'if (reservationError)')).toBeLessThan(at(body, 'if (!reservation || reservation.request_id) return;'));
  });

  it('it still returns rather than acting on an unknown reservation', () => {
    // Acting blind here is worse than not acting: the writes below step a rule
    // past an occurrence somebody else's worker may still own.
    const bail = bodyOf(cron, 'if (reservationError)', '\n  }');
    expect(bail).toContain('return;');
    expect(bail).not.toContain('.update(');
  });
});

/**
 * Audit C1-S9-39 — the guardian call/message screening surface and push
 * registration: the insert/upsert bucket from the C1-S9-37 inventory.
 *
 * The trade-off here is INVERTED relative to every page in this file. These are
 * Twilio webhooks on a live call, so failing closed drops a real caller — and
 * the caller Guardian exists to protect is as likely to be a grandchild as a
 * fraudster. The rule this feature already states for itself, in
 * `guardian/screen/route.ts`, is the one applied throughout: *"Saying goodbye
 * is right for a duplicate and wrong for an outage… A 503 lets Twilio fall
 * back."* So: 503 where the call cannot meaningfully continue, and a loud log
 * where it can.
 */
const guardVoice = readFileSync('app/api/guardian/inbound/voice/route.ts', 'utf8');
const guardWhats = readFileSync('app/api/guardian/inbound/whatsapp/route.ts', 'utf8');
const guardScreen = readFileSync('app/api/guardian/screen/route.ts', 'utf8');
const pushSubscribe = readFileSync('app/api/push/subscribe/route.ts', 'utf8');

describe('guardian does not hang up on a live call because a read failed (C1-S9-39)', () => {
  it('the screening session read obeys the rule written eleven lines above it', () => {
    // The file states it on the callback claim and then broke it: a dropped
    // error hung up on a live screening call with "thank you for calling,
    // goodbye" — indistinguishable, to the caller, from being screened out.
    expect(guardScreen).toContain('error: sessionError');
    expect(bodyOf(guardScreen, 'if (sessionError)', '{ status: 503 }')).toContain('console.error');
    // The goodbye is KEPT for the case it is right for: a session that is
    // genuinely absent or no longer active.
    expect(guardScreen).toContain("if (!session || (session as { status: string }).status !== 'active')");
    expect(at(guardScreen, 'if (sessionError)'))
      .toBeLessThan(at(guardScreen, "if (!session || (session as { status: string }).status !== 'active')"));
  });

  it('a screening session that could not be opened falls back instead of gathering into nothing', () => {
    // The session id goes straight into the TwiML gather action, so a failed
    // insert produced `?sessionId=&turn=1`: the AI greets the caller, the caller
    // answers, and the reply hits an endpoint that rejects an empty id with 400.
    expect(guardVoice).toContain('error: sessionError');
    expect(guardVoice).toContain('if (sessionError || !session?.id)');
    expect(bodyOf(guardVoice, 'if (sessionError || !session?.id)', '{ status: 503 }')).toContain('console.error');
    expect(at(guardVoice, 'if (sessionError || !session?.id)')).toBeLessThan(at(guardVoice, 'twimlGather({'));
    // And `.single()` is not used to detect it — that throws on absence rather
    // than reporting it, which is the trap C1-S9-38 documents.
    expect(bodyOf(guardVoice, "gFrom('guardian_screening_sessions').insert(", '.maybeSingle();')).not.toContain('.single()');
  });

  it.each([
    ['voice', () => guardVoice, 'commError'],
    ['whatsapp', () => guardWhats, 'commError'],
  ])('%s records a failed communication log rather than losing it silently', (_n, get, binding) => {
    const source = get();
    expect(source).toContain(`error: ${binding}`);
    expect(source).toContain(`if (${binding})`);
    // The call/message must still go through: logged, NOT turned into a 503.
    const bail = bodyOf(source, `if (${binding})`, '\n  }');
    expect(bail).toContain('console.error');
    expect(bail).not.toContain('status: 503');
    expect(bail).not.toContain('return');
  });

  it('a communication status change is confirmed, not assumed', () => {
    // A call shown as `received` forever, when it was blocked or handled, is a
    // guardian history that disagrees with what happened — and the status is
    // what the family reads to judge whether screening works.
    const body = bodyOf(guardVoice, 'async function updateCommStatus', '\n}');
    expect(body).toContain(".select('id')");
    expect(body).toContain('wroteNoRows(updated)');
    expect(body).toContain('console.error');
  });
});

describe('a push device is not registered into the wrong scope (C1-S9-39)', () => {
  it('a failed family lookup refuses rather than registering unscoped', () => {
    // `family_id` is genuinely nullable, so a refused read produced the same
    // null as a user with no family. `lib/server/push.ts` filters candidates by
    // `family_id`, so the row persists and the device misses every
    // family-scoped notification until a later subscribe happens to succeed.
    expect(pushSubscribe).toContain('error: memberError');
    expect(pushSubscribe).toContain('if (memberError)');
    const bail = bodyOf(pushSubscribe, 'if (memberError)', '{ status: 503 });');
    expect(bail).toContain('console.error');
    expect(bail).toContain('subscribe.couldNotRegisterThisDevice');
    // Before the upsert that would write the wrong scope.
    expect(at(pushSubscribe, 'if (memberError)')).toBeLessThan(at(pushSubscribe, "from('push_devices').upsert("));
  });

  it('the genuine no-family case still registers', () => {
    // Refusing every null would lock out users who legitimately have no family.
    expect(pushSubscribe).toContain('member?.family_id ?? null');
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['subscribe.couldNotRegisterThisDevice'], `${locale} is missing it`).toBeTruthy();
    }
  });
});

/**
 * Audit C1-S9-40 — four more from the C1-S9-37 inventory, and the distinction
 * that decides each one: does the fallback give a SMALLER answer, or a
 * DIFFERENT one?
 *
 * A missing first name makes an AI reply blander. A missing asset makes it an
 * answer to a different question. Both are "the read failed and we continued",
 * and only one of them is acceptable.
 */
const behavior = readFileSync('app/api/behavior/insight/route.ts', 'utf8');
const aiGift = readFileSync('app/api/ai/gift/route.ts', 'utf8');
const aiInsights = readFileSync('app/api/ai/insights/route.ts', 'utf8');
const aiInvest = readFileSync('app/api/ai/invest/route.ts', 'utf8');

describe('a parent is not told their behaviour log is empty (C1-S9-40)', () => {
  it('a refused read is a 503, not "nothing logged yet"', () => {
    // At HTTP 200 it read as a statement of fact about their family, inviting
    // them to start doing what they had already been doing for months — and the
    // rows behind it include the concerns they recorded.
    expect(behavior).toContain('error: logsError');
    expect(bodyOf(behavior, 'if (logsError)', '{ status: 503 }')).toContain('console.error');
    // The genuine empty state is kept: it is right for a family that has not
    // started, which is who the copy was written for.
    expect(behavior).toContain('if (!logs || logs.length === 0)');
    expect(at(behavior, 'if (logsError)')).toBeLessThan(at(behavior, 'if (!logs || logs.length === 0)'));
  });
});

describe('a gift link is not declared dead because a read failed (C1-S9-40)', () => {
  it('the twin of C1-S9-31, in the same feature', () => {
    // /pay/<handle> redirects here, so these two are one user journey: someone
    // outside the family trying to send money.
    expect(aiGift).toContain('error: linkError');
    expect(bodyOf(aiGift, 'if (linkError)', '{ status: 503 }')).toContain('console.error');
    expect(aiGift).toContain("t('gift.thisGiftLinkIsNo')");
    expect(at(aiGift, 'if (linkError)')).toBeLessThan(at(aiGift, "t('gift.thisGiftLinkIsNo')"));
  });
});

describe('an AI answer is not generated for a family with no members (C1-S9-40)', () => {
  it('the roster read matches the convention its own neighbour sets', () => {
    // `fetchRows`, ten lines below, already 500s when it cannot load. This read
    // dropped its error and fed an empty member list into the same prompt.
    expect(aiInsights).toContain('error: membersError');
    expect(bodyOf(aiInsights, 'if (membersError)', '{ status: 500 }')).toContain('console.error');
    expect(at(aiInsights, 'if (membersError)')).toBeLessThan(at(aiInsights, 'rows = await fetchRows('));
  });
});

describe('smaller answer versus different answer (C1-S9-40)', () => {
  it('the invest name lookups degrade and say so', () => {
    // "your child" instead of a first name is blander, not wrong. Logged, and
    // deliberately NOT a 503 — a guard asserts that, so the fix cannot be
    // "tightened" into failing a request over a cosmetic fallback.
    for (const binding of ['cwError', 'mError']) {
      expect(aiInvest, binding).toContain(`if (${binding}) console.warn(`);
    }
    expect(aiInvest).toContain("let childName = 'your child';");
    expect(stripComments(aiInvest)).not.toMatch(/if \((cwError|mError)\)[\s\S]{0,200}?status: 503/);
  });

  it('the asset the child actually chose does not', () => {
    // A refused read left name, description AND risk level null, and the model
    // gave a child investing guidance about an asset it knew nothing about —
    // including the risk level, the one fact this feature exists to teach.
    expect(aiInvest).toContain('error: assetError');
    expect(bodyOf(aiInvest, 'if (assetError)', '{ status: 503 }')).toContain('console.error');
    expect(at(aiInvest, 'if (assetError)')).toBeLessThan(at(aiInvest, 'if (a) { assetName = a.name;'));
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['insight.behaviorDataIsTemporarilyUnavailable', 'gift.giftDataIsTemporarilyUnavailable']) {
        expect(catalogue[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});
