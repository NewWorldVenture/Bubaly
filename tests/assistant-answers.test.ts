import { describe, it, expect } from 'vitest';
import {
  agendaSpeech, nextSpeech, forgettingSpeech, speakTime, SPOKEN_ITEM_LIMIT,
  CAPTURE_NOT_ALLOWED_SPEECH, ERROR_SPEECH,
} from '@/lib/assistant/answers';
import { MAX_SPEECH_CHARS } from '@/lib/assistant/intent';

const NY = 'America/New_York';
const event = (title: string, starts_at: string, all_day = false) => ({ title, starts_at, all_day });

describe('times are said the way people say them', () => {
  it('drops the minutes on the hour', () => {
    // "3:00 PM" is read aloud as "three o'clock zero zero" by some engines.
    expect(speakTime('2026-03-10T19:00:00Z', NY)).toBe('3pm');
  });

  it('keeps them when they matter', () => {
    expect(speakTime('2026-03-10T14:30:00Z', NY)).toBe('10:30am');
  });

  it('reads the family’s own zone, not the server’s', () => {
    const iso = '2026-03-10T19:00:00Z';
    expect(speakTime(iso, NY)).toBe('3pm');
    expect(speakTime(iso, 'Europe/London')).toBe('7pm');
    expect(speakTime(iso, 'Asia/Kolkata')).toBe('12:30am');
  });

  it('says nothing rather than "Invalid Date" for a broken timestamp', () => {
    expect(speakTime('not-a-date', NY)).toBe('');
  });
});

describe('the day, read aloud', () => {
  it('answers an empty day as news, not silence', () => {
    // An assistant that says nothing is indistinguishable from one that failed.
    expect(agendaSpeech([], 'today', NY)).toBe('Nothing is on the calendar for today.');
    expect(agendaSpeech([], 'tomorrow', NY)).toBe('Nothing is on the calendar for tomorrow.');
  });

  it('leads with the count, then names the items', () => {
    const speech = agendaSpeech([
      event('Dentist', '2026-03-10T19:00:00Z'),
      event('School play', '2026-03-10T23:00:00Z'),
    ], 'today', NY);
    expect(speech).toBe('You have 2 things today: Dentist at 3pm and School play at 7pm.');
  });

  it('says "thing" for one and "things" for more', () => {
    expect(agendaSpeech([event('Dentist', '2026-03-10T19:00:00Z')], 'today', NY))
      .toBe('You have 1 thing today: Dentist at 3pm.');
  });

  it('does not read an all-day event a time it does not have', () => {
    expect(agendaSpeech([event('Half term', '2026-03-10T00:00:00Z', true)], 'today', NY))
      .toBe('You have 1 thing today: Half term.');
  });

  it('stops naming items and counts the rest', () => {
    // Four items read in a row is already more than a listener retains.
    const speech = agendaSpeech([
      event('One', '2026-03-10T13:00:00Z'), event('Two', '2026-03-10T14:00:00Z'),
      event('Three', '2026-03-10T15:00:00Z'), event('Four', '2026-03-10T16:00:00Z'),
      event('Five', '2026-03-10T17:00:00Z'),
    ], 'today', NY);
    expect(speech).toContain('and 2 more');
    expect(speech).not.toContain('Four');
    expect(SPOKEN_ITEM_LIMIT).toBe(3);
  });

  it('never reads markdown out of a user-written title', () => {
    const speech = agendaSpeech([event('**URGENT** see https://x.test/a', '2026-03-10T19:00:00Z')], 'today', NY);
    expect(speech).not.toMatch(/[*_`#>|]|https?:/);
    expect(speech).toContain('a link');
  });

  it('stays inside what is worth speaking', () => {
    const many = Array.from({ length: 40 }, (_, i) => event(`Event number ${i} with a long name`, '2026-03-10T19:00:00Z'));
    expect(agendaSpeech(many, 'today', NY).length).toBeLessThanOrEqual(MAX_SPEECH_CHARS + 1);
  });
});

describe('what is next', () => {
  it('names the first thing and when', () => {
    expect(nextSpeech([event('Dentist', '2026-03-10T19:00:00Z')], NY)).toBe('Next up: Dentist at 3pm.');
  });

  it('says the rest of the day is clear', () => {
    expect(nextSpeech([], NY)).toBe('Nothing else is scheduled today.');
  });

  it('phrases an all-day item without a time', () => {
    expect(nextSpeech([event('Half term', '2026-03-10T00:00:00Z', true)], NY)).toBe('Next up today: Half term.');
  });
});

describe('what am I forgetting', () => {
  const TODAY = '2026-03-10';

  it('gives the reassurance the question is asked for', () => {
    expect(forgettingSpeech([], TODAY))
      .toBe('Nothing is overdue and nothing is due today. You are on top of it.');
  });

  it('separates overdue from due today, because they feel different', () => {
    const speech = forgettingSpeech([
      { title: 'Renew passport', due_date: '2026-03-01' },
      { title: 'Pay the school trip', due_date: TODAY },
    ], TODAY);
    expect(speech).toBe('1 thing is overdue: Renew passport. 1 is due today: Pay the school trip.');
  });

  it('agrees its verbs with the count', () => {
    const speech = forgettingSpeech([
      { title: 'A', due_date: '2026-03-01' }, { title: 'B', due_date: '2026-03-02' },
    ], TODAY);
    expect(speech).toContain('2 things are overdue');
  });

  it('ignores tasks with no due date rather than calling them forgotten', () => {
    // A task nobody dated is not overdue; saying it is would make the check
    // cry wolf and people would stop asking.
    expect(forgettingSpeech([{ title: 'Someday: paint the shed', due_date: null }], TODAY))
      .toBe('Nothing is overdue and nothing is due today. You are on top of it.');
  });

  it('does not count tomorrow as forgotten', () => {
    expect(forgettingSpeech([{ title: 'Tomorrow thing', due_date: '2026-03-11' }], TODAY))
      .toBe('Nothing is overdue and nothing is due today. You are on top of it.');
  });
});

describe('the two things it says when it will not or cannot act', () => {
  it('explains a read-only link instead of failing silently', () => {
    expect(CAPTURE_NOT_ALLOWED_SPEECH).toContain('not allowed to add things');
    expect(CAPTURE_NOT_ALLOWED_SPEECH).toContain('Settings');
  });

  it('promises nothing changed when something broke', () => {
    expect(ERROR_SPEECH).toContain('not changed anything');
  });
});
