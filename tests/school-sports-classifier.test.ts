// The school/sports front-desk classifier, pinned exhaustively.
//
// Everything here runs without a database, a clock or a network, because the
// module under test has none of the three. That is the point of the test as
// much as of the module: a family's permission slip must classify the same way
// on a webhook at 3am and in a browser at noon, and the only way to know that
// is to be able to assert it from a plain function call.
import { describe, it, expect } from 'vitest';
import {
  buildProposal,
  classify,
  frontDeskDomain,
  gearItems,
  messageTitle,
  FRONT_DESK_SUB_KINDS,
  type FrontDeskSubKind,
  type RosterClass,
  type RosterMember,
  type RosterTeam,
} from '@/lib/front-desk/school-sports';

/** A fixed instant, so a year-less date resolves the same way on every run. */
const NOW = '2026-09-09T12:00:00.000Z';
const OPTS = { now: NOW };

const MEMBERS: RosterMember[] = [
  { id: 'm-ava', display_name: 'Ava Hughen' },
  { id: 'm-noah', display_name: 'Noah Hughen' },
  { id: 'm-mum', display_name: 'Sarah Hughen' },
];

const TEAMS: RosterTeam[] = [
  { member_id: 'm-noah', team_name: 'Riverside Rovers', sport: 'soccer', coach: 'Coach Delgado' },
  { member_id: null, team_name: 'Unassigned Squad', sport: 'hockey', coach: null },
];

const CLASSES: RosterClass[] = [
  { member_id: 'm-ava', subject: 'Math', teacher: 'Mrs Okonkwo', school_name: 'Lincoln Elementary' },
];

describe('domain detection', () => {
  it('recognises school work', () => {
    expect(classify({ body: 'Reminder: the permission slip for the field trip is due.' }, [], [], [], OPTS).domain).toBe('school');
    expect(classify({ subject: 'Parent-teacher evening', body: 'Please book a slot.' }, [], [], [], OPTS).domain).toBe('school');
    expect(classify({ body: 'Homework club starts next week at school.' }, [], [], [], OPTS).domain).toBe('school');
  });

  it('recognises sports work', () => {
    expect(classify({ body: 'Practice is at the pitch. Bring cleats.' }, [], [], [], OPTS).domain).toBe('sports');
    expect(classify({ body: 'The coach has posted the roster for Saturday’s tournament.' }, [], [], [], OPTS).domain).toBe('sports');
  });

  it('reads the sender when the body says little', () => {
    expect(classify({ body: 'See attached.', from_addr: 'office@lincoln.k12.us' }, [], [], [], OPTS).domain).toBe('school');
    expect(classify({ body: 'See attached.', from_addr: 'admin@riversidesoccerclub.org' }, [], [], [], OPTS).domain).toBe('sports');
  });

  it('uses the family roster as evidence a word list cannot have', () => {
    // "Delgado" means nothing to a keyword pass; the family said he coaches Noah.
    const verdict = classify({ body: 'A note from Delgado about Saturday.' }, MEMBERS, TEAMS, CLASSES, OPTS);
    expect(verdict.domain).toBe('sports');
    expect(verdict.child).toEqual({ member_id: 'm-noah', name: 'Noah Hughen' });
  });

  it('breaks an exact tie on whichever signal the message leads with', () => {
    expect(classify({ body: 'School office: the team photo is Friday.' }, [], [], [], OPTS).domain).toBe('school');
    expect(classify({ body: 'Team news: the school photo is Friday.' }, [], [], [], OPTS).domain).toBe('sports');
  });

  it('frontDeskDomain is the text-only shorthand for the same verdict', () => {
    expect(frontDeskDomain('Permission slip for the school field trip')).toBe('school');
    expect(frontDeskDomain('Soccer practice moved to 6pm')).toBe('sports');
    expect(frontDeskDomain('Your parcel was left at the door')).toBeNull();
    expect(frontDeskDomain('')).toBeNull();
    expect(frontDeskDomain(null)).toBeNull();
  });
});

describe('false-positive guards', () => {
  const unrelated: { label: string; text: string }[] = [
    { label: 'a grocery receipt', text: 'Whole Foods receipt. Total due $84.32. Paid by card ending 4412 on 09/07.' },
    { label: 'a delivery notice', text: 'Your package is out for delivery and will arrive today.' },
    { label: 'a dentist appointment', text: 'Can we reschedule the dentist appointment for the 14th? $120 due at the visit.' },
    { label: 'a utility bill', text: 'Your electricity invoice of $210.55 is due on 2026-09-20. Pay online to avoid a late fee.' },
    { label: 'a plumber quote', text: 'Free quote for the boiler: $450, payable on completion.' },
    { label: 'small talk', text: 'Hey, are we still on for dinner Saturday?' },
  ];

  for (const { label, text } of unrelated) {
    it(`leaves ${label} unclassified`, () => {
      const verdict = classify({ body: text }, MEMBERS, TEAMS, CLASSES, OPTS);
      expect(verdict.domain).toBeNull();
      expect(verdict.subKind).toBeNull();
      expect(verdict.confidence).toBe(0);
      // And nothing is proposed for it, which is the half that matters.
      expect(buildProposal({ body: text }, verdict)).toBeNull();
    });
  }

  it('a grocery receipt is not a fee even though it has an amount and the word due', () => {
    const receipt = { body: 'Corner Market. Amount due $12.40 for milk, bread and eggs.' };
    expect(classify(receipt, MEMBERS, TEAMS, CLASSES, OPTS).subKind).toBeNull();
  });

  it('suppresses a promotional flyer that only borrows the vocabulary', () => {
    const flyer = { body: 'Limited-time offer: 30% off team jerseys. Shop now!' };
    expect(classify(flyer, [], [], [], OPTS).domain).toBeNull();
  });

  it('but keeps a real message that happens to mention a discount', () => {
    const real = {
      body: 'School office: the field trip permission slip is due Friday. The PTA has a promo code for the gift shop.',
    };
    expect(classify(real, [], [], [], OPTS).domain).toBe('school');
  });

  it('never sets a sub-kind without a domain', () => {
    for (const text of unrelated.map((u) => u.text)) {
      expect(classify({ body: text }, [], [], [], OPTS).subKind).toBeNull();
    }
  });
});

describe('sub-kinds', () => {
  const cases: { kind: FrontDeskSubKind; text: string }[] = [
    { kind: 'form', text: 'School: please sign and return the permission slip for the field trip.' },
    { kind: 'fee', text: 'Soccer club: the registration fee for the season is now open for payment.' },
    { kind: 'gear', text: 'Practice tomorrow — please bring cleats and a water bottle.' },
    { kind: 'transport', text: 'The school bus route has changed; pick-up is now from the corner.' },
    { kind: 'schedule_change', text: 'Practice has been cancelled; the coach will confirm a new time.' },
  ];

  for (const { kind, text } of cases) {
    it(`recognises ${kind}`, () => {
      expect(classify({ body: text }, [], [], [], OPTS).subKind).toBe(kind);
    });
  }

  it('covers every sub-kind the module exports', () => {
    expect([...FRONT_DESK_SUB_KINDS].sort()).toEqual([...new Set(cases.map((c) => c.kind))].sort());
  });

  it('prefers the schedule change when a message carries several', () => {
    const both = { body: 'Soccer practice is moved to 6pm on Friday. Please bring shin guards.' };
    expect(classify(both, [], [], [], OPTS).subKind).toBe('schedule_change');
  });

  it('prefers the form over the fee when a slip carries both', () => {
    const both = { body: 'School: sign and return the permission slip. The field trip fee is $12.' };
    expect(classify(both, [], [], [], OPTS).subKind).toBe('form');
  });

  it('calls it a fee when money is owed but no fee word is used', () => {
    const owed = { body: 'Sports club: please pay £25 for Ava before the tournament.' };
    const verdict = classify(owed, [], [], [], OPTS);
    expect(verdict.subKind).toBe('fee');
    expect(verdict.amount_cents).toBe(2500);
  });

  it('leaves a school message with no actionable kind at null', () => {
    const verdict = classify({ body: 'The school newsletter is attached for your interest.' }, [], [], [], OPTS);
    expect(verdict.domain).toBe('school');
    expect(verdict.subKind).toBeNull();
  });
});

describe('amounts', () => {
  const money: { text: string; cents: number; currency: string }[] = [
    { text: 'School trip fee of $25', cents: 2500, currency: 'USD' },
    { text: 'School trip fee of $25.50', cents: 2550, currency: 'USD' },
    { text: 'School fees total $1,250.75 this term', cents: 125075, currency: 'USD' },
    { text: 'Soccer club dues are €40 per season', cents: 4000, currency: 'EUR' },
    { text: 'The school kit costs £9.5 in total', cents: 950, currency: 'GBP' },
    { text: 'School: the fee is 30 dollars', cents: 3000, currency: 'USD' },
    { text: 'Team fee: USD 15 per player', cents: 1500, currency: 'USD' },
  ];

  for (const { text, cents, currency } of money) {
    it(`reads ${JSON.stringify(text)}`, () => {
      const verdict = classify({ body: text }, [], [], [], OPTS);
      expect(verdict.amount_cents).toBe(cents);
      expect(verdict.currency).toBe(currency);
    });
  }

  it('never reads an unsigned number as money', () => {
    const verdict = classify({ body: 'School practice runs for 45 minutes in 2026.' }, [], [], [], OPTS);
    expect(verdict.amount_cents).toBeUndefined();
    expect(verdict.currency).toBeUndefined();
  });
});

describe('dates and times', () => {
  it('reads an explicit ISO date', () => {
    expect(classify({ body: 'School: the form is due 2026-10-02.' }, [], [], [], OPTS).date).toBe('2026-10-02');
  });

  it('reads a spelled month, with or without a year', () => {
    expect(classify({ body: 'School trip on September 14, 2027.' }, [], [], [], OPTS).date).toBe('2027-09-14');
    expect(classify({ body: 'School trip on Sept 14.' }, [], [], [], OPTS).date).toBe('2026-09-14');
    expect(classify({ body: 'School trip on 14 September.' }, [], [], [], OPTS).date).toBe('2026-09-14');
  });

  it('rolls a year-less date that is well past into next year', () => {
    // 3 February is seven months behind 9 September 2026, so it is 2027's.
    expect(classify({ body: 'School: swimming starts 3 February.' }, [], [], [], OPTS).date).toBe('2027-02-03');
  });

  it('reads a numeric date month-first, and only as a last resort', () => {
    expect(classify({ body: 'School form due 10/02/2026.' }, [], [], [], OPTS).date).toBe('2026-10-02');
    // A spelled month anywhere in the message wins over a numeric one.
    expect(classify({ body: 'School form due October 2, 2026 (ref 11/12).' }, [], [], [], OPTS).date).toBe('2026-10-02');
  });

  it('refuses a year-less date when it is given no reference instant', () => {
    expect(classify({ body: 'School trip on Sept 14.' }, [], [], []).date).toBeUndefined();
    // A date that states its own year still resolves without one.
    expect(classify({ body: 'School trip on Sept 14, 2027.' }, [], [], []).date).toBe('2027-09-14');
  });

  it('rejects a date that does not exist', () => {
    expect(classify({ body: 'School notice dated 2026-02-30.' }, [], [], [], OPTS).date).toBeUndefined();
  });

  it('reads a month spelled in full', () => {
    expect(classify({ body: 'School trip on December 3, 2026.' }, [], [], [], OPTS).date).toBe('2026-12-03');
    expect(classify({ body: 'School trip on 3 December 2026.' }, [], [], [], OPTS).date).toBe('2026-12-03');
  });

  it('does not read a word that merely starts like a month', () => {
    // "Junior 5" is not the fifth of June, and "Marching band 12" is not March.
    expect(classify({ body: 'School: Junior 5 assembly.' }, [], [], [], OPTS).date).toBeUndefined();
    expect(classify({ body: 'School: Marching band 12 meets weekly.' }, [], [], [], OPTS).date).toBeUndefined();
    expect(classify({ body: 'School: Augmented reality club 4 starts.' }, [], [], [], OPTS).date).toBeUndefined();
  });

  it('reads a time only when the message states one', () => {
    expect(classify({ body: 'Practice moved to 6pm.' }, [], [], [], OPTS).time).toBe('18:00');
    expect(classify({ body: 'Practice moved to 6:30 p.m.' }, [], [], [], OPTS).time).toBe('18:30');
    expect(classify({ body: 'Practice moved to 9am.' }, [], [], [], OPTS).time).toBe('09:00');
    expect(classify({ body: 'Practice starts at 17:45.' }, [], [], [], OPTS).time).toBe('17:45');
    expect(classify({ body: 'Practice is midday on Friday.' }, [], [], [], OPTS).time).toBeUndefined();
  });

  it('reads midnight and noon the way a clock does', () => {
    expect(classify({ body: 'School doors open 12am.' }, [], [], [], OPTS).time).toBe('00:00');
    expect(classify({ body: 'School doors open 12pm.' }, [], [], [], OPTS).time).toBe('12:00');
  });
});

describe('which child', () => {
  it('matches a full name over a first name', () => {
    const verdict = classify({ body: 'School: Ava Hughen needs a permission slip; Noah is fine.' }, MEMBERS, [], [], OPTS);
    expect(verdict.child).toEqual({ member_id: 'm-ava', name: 'Ava Hughen' });
  });

  it('matches a first name on its own', () => {
    const verdict = classify({ body: 'School: Noah left his homework at home.' }, MEMBERS, [], [], OPTS);
    expect(verdict.child).toEqual({ member_id: 'm-noah', name: 'Noah Hughen' });
  });

  it('matches through a teacher the family recorded', () => {
    const verdict = classify({ body: 'A note from Mrs Okonkwo about the school trip.' }, MEMBERS, [], CLASSES, OPTS);
    expect(verdict.child).toEqual({ member_id: 'm-ava', name: 'Ava Hughen' });
  });

  it('picks the first child named when two are equally matched', () => {
    const verdict = classify({ body: 'School: Noah and Ava both need forms.' }, MEMBERS, [], [], OPTS);
    expect(verdict.child?.member_id).toBe('m-noah');
  });

  it('names nobody when the message names nobody', () => {
    expect(classify({ body: 'School: the office is closed on Monday.' }, MEMBERS, [], [], OPTS).child).toBeUndefined();
  });

  it('does not match a name inside a longer word', () => {
    // "Avalanche" contains "Ava" and is not a child.
    expect(classify({ body: 'School trip to the Avalanche exhibit.' }, MEMBERS, [], [], OPTS).child).toBeUndefined();
  });

  it('ignores a roster row that names no member', () => {
    const verdict = classify({ body: 'Unassigned Squad practice is Friday.' }, MEMBERS, TEAMS, [], OPTS);
    expect(verdict.domain).toBe('sports');
    expect(verdict.child).toBeUndefined();
  });
});

describe('determinism', () => {
  const sample = {
    subject: 'Field trip — permission slip',
    body: 'Ava needs the slip signed by Sept 14. The fee is $12.50 and the bus leaves at 8:15am.',
    from_addr: 'office@lincoln.k12.us',
  };

  it('gives the identical answer every time', () => {
    const first = classify(sample, MEMBERS, TEAMS, CLASSES, OPTS);
    for (let i = 0; i < 25; i++) {
      expect(classify(sample, MEMBERS, TEAMS, CLASSES, OPTS)).toEqual(first);
    }
  });

  it('does not depend on roster order', () => {
    const a = classify(sample, MEMBERS, TEAMS, CLASSES, OPTS);
    const b = classify(sample, [...MEMBERS].reverse(), [...TEAMS].reverse(), [...CLASSES].reverse(), OPTS);
    expect(b).toEqual(a);
  });

  it('does not mutate what it is given', () => {
    const members = MEMBERS.map((m) => ({ ...m }));
    const snapshot = JSON.stringify({ sample, members });
    classify(sample, members, TEAMS, CLASSES, OPTS);
    expect(JSON.stringify({ sample, members })).toBe(snapshot);
  });

  it('scores confidence between 0 and 0.95, and 0 for no domain', () => {
    expect(classify(sample, MEMBERS, TEAMS, CLASSES, OPTS).confidence).toBeGreaterThan(0.5);
    expect(classify(sample, MEMBERS, TEAMS, CLASSES, OPTS).confidence).toBeLessThanOrEqual(0.95);
    expect(classify({ body: 'nothing to see' }, [], [], [], OPTS).confidence).toBe(0);
  });

  it('answers an empty message with nothing', () => {
    expect(classify({}, MEMBERS, TEAMS, CLASSES, OPTS)).toEqual({ domain: null, subKind: null, confidence: 0 });
    expect(classify({ subject: '   ', body: null, from_addr: null }, [], [], [], OPTS).domain).toBeNull();
  });
});

describe('gear extraction', () => {
  it('takes the words the message used, in the order it used them', () => {
    expect(gearItems({ body: 'Bring a water bottle, cleats and shin guards.' }))
      .toEqual(['water bottle', 'cleats', 'shin guards']);
  });

  it('de-duplicates without inventing anything', () => {
    expect(gearItems({ body: 'Bring cleats. Cleats are required.' })).toEqual(['cleats']);
    expect(gearItems({ body: 'Nothing to bring.' })).toEqual([]);
  });
});

describe('what gets proposed', () => {
  it('a schedule change with a date and time becomes a timed calendar event', () => {
    const message = { subject: 'Practice moved', body: 'Soccer practice is moved to 6pm on Sept 18 for Noah.' };
    const proposal = buildProposal(message, classify(message, MEMBERS, TEAMS, CLASSES, OPTS));
    expect(proposal).toEqual({
      name: 'create_calendar_event',
      domain: 'calendar',
      subject: 'Practice moved',
      args: {
        title: 'Practice moved',
        starts_at: '2026-09-18T18:00:00',
        all_day: false,
        category: 'sports',
        assignee_id: 'm-noah',
      },
    });
  });

  it('a dated change with no time becomes an all-day event', () => {
    const message = { subject: 'School closed', body: 'School is closed; the date has been changed to Oct 2.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.args.all_day).toBe(true);
    expect(proposal?.args.starts_at).toBe('2026-10-02T00:00:00');
    expect(proposal?.args.category).toBe('school');
  });

  it('a form becomes a reminder on the day the message names', () => {
    const message = { subject: 'Permission slip', body: 'School: sign and return the permission slip by Sept 14.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal).toEqual({
      name: 'create_reminder',
      domain: 'scheduling',
      subject: 'Permission slip',
      args: { title: 'Permission slip', remind_at: '2026-09-14T09:00:00', kind: 'school' },
    });
  });

  it('a fee reminder is filed as a bill', () => {
    const message = { subject: 'Season fee', body: 'Soccer club: the registration fee of $75 is due Sept 30.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.name).toBe('create_reminder');
    expect(proposal?.args.kind).toBe('bill');
    expect(proposal?.args.remind_at).toBe('2026-09-30T09:00:00');
  });

  it('never invents a date it was not given', () => {
    const message = { subject: 'Form', body: 'School: please sign and return the form when you can.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.args.remind_at).toBeNull();
  });

  it('a change with no date at all falls back to a reminder rather than a made-up event', () => {
    const message = { subject: 'Practice cancelled', body: 'Soccer practice has been cancelled until further notice.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.name).toBe('create_reminder');
    expect(proposal?.args.remind_at).toBeNull();
  });

  it('gear becomes shopping-list items', () => {
    const message = { subject: 'Kit for Saturday', body: 'Practice: please bring cleats and a water bottle.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.name).toBe('add_grocery_item');
    expect(proposal?.domain).toBe('shopping');
    expect(proposal?.args.items).toEqual([{ name: 'cleats' }, { name: 'water bottle' }]);
  });

  it('gear with nothing nameable falls back to a reminder', () => {
    const message = { subject: 'Bring something', body: 'School: please bring the usual things to the assembly.' };
    const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
    expect(proposal?.name).toBe('create_reminder');
  });

  it('only ever names a tool that already exists and is already gated', () => {
    const allowed = ['create_calendar_event', 'create_reminder', 'add_grocery_item'];
    const messages = [
      { body: 'School: sign and return the permission slip by Sept 14.' },
      { body: 'Soccer: the fee of $75 is due Sept 30.' },
      { body: 'Practice: bring cleats.' },
      { body: 'The school bus pick-up moves to 8am on Sept 20.' },
      { body: 'Practice is cancelled.' },
      { body: 'The school newsletter is attached.' },
    ];
    for (const message of messages) {
      const proposal = buildProposal(message, classify(message, [], [], [], OPTS));
      expect(proposal).not.toBeNull();
      expect(allowed).toContain(proposal?.name);
    }
  });

  it('proposes nothing for a message with no words to title a row with', () => {
    const verdict = classify({ from_addr: 'office@lincoln.k12.us' }, [], [], [], OPTS);
    expect(verdict.domain).toBe('school');
    expect(buildProposal({ from_addr: 'office@lincoln.k12.us' }, verdict)).toBeNull();
  });

  it('titles a row from the subject, or the first line of the body', () => {
    expect(messageTitle({ subject: '  Field   trip  ', body: 'x' })).toBe('Field trip');
    expect(messageTitle({ subject: '', body: '\n\n  Practice moved \nmore text' })).toBe('Practice moved');
    expect(messageTitle({})).toBe('');
    expect(messageTitle({ subject: 'x'.repeat(200) }).length).toBe(120);
  });
});
