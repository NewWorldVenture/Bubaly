import { describe, expect, it } from 'vitest';
import { parseICS, parseICSReport } from '@/lib/migrate/parse';

// LIBRARY-1A51F1B8FECA. Google, Apple and Outlook export each event's reminder
// as a VALARM nested inside the VEVENT, and a VALARM carries its own
// DESCRIPTION (and, for an email alarm, its own SUMMARY). The importer tracked
// only BEGIN/END:VEVENT, so the alarm's "This is an event reminder" replaced
// the event's notes and "Alarm notification" replaced its title, on the
// family's calendar, with nothing to say so.

const withAlarms = (...alarms: string[]) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART:20260514T173000Z',
  'DTEND:20260514T190000Z',
  'SUMMARY:Soccer practice',
  'DESCRIPTION:Bring water and shin guards',
  'LOCATION:City Field',
  ...alarms,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const DISPLAY_ALARM = [
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
].join('\r\n');

const EMAIL_ALARM = [
  'BEGIN:VALARM',
  'ACTION:EMAIL',
  'SUMMARY:Alarm notification',
  'DESCRIPTION:This is an event reminder',
  'ATTENDEE:mailto:parent@example.test',
  'TRIGGER:-P1D',
  'END:VALARM',
].join('\r\n');

const OWN = {
  title: 'Soccer practice',
  startsAt: '2026-05-14T17:30:00.000Z',
  endsAt: '2026-05-14T19:00:00.000Z',
  allDay: false,
  location: 'City Field',
  description: 'Bring water and shin guards',
};

describe('an imported event keeps its own title and notes beside its alarm', () => {
  it('a display alarm does not replace the event description', () => {
    expect(parseICS(withAlarms(DISPLAY_ALARM))).toEqual([OWN]);
  });

  it('an email alarm replaces neither the title nor the description', () => {
    expect(parseICS(withAlarms(EMAIL_ALARM))).toEqual([OWN]);
  });

  it('two alarms, as a Google export with two reminders writes them', () => {
    expect(parseICS(withAlarms(DISPLAY_ALARM, EMAIL_ALARM))).toEqual([OWN]);
  });

  it('an alarm that comes BEFORE the event properties gives the event nothing either', () => {
    const ics = [
      'BEGIN:VEVENT',
      DISPLAY_ALARM,
      'DTSTART:20260514T173000Z',
      'SUMMARY:Soccer practice',
      'END:VEVENT',
    ].join('\n');
    expect(parseICS(ics)).toEqual([{ ...OWN, endsAt: null, location: null, description: null }]);
  });

  it('an alarm with a start of its own does not move the event', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260514T173000Z',
      'SUMMARY:Soccer practice',
      'BEGIN:VALARM',
      'DTSTART:20200101T000000Z',
      'LOCATION:Nowhere',
      'END:VALARM',
      'END:VEVENT',
    ].join('\n');
    const [event] = parseICS(ics);
    expect(event.startsAt).toBe('2026-05-14T17:30:00.000Z');
    expect(event.location).toBeNull();
  });

  it('the event after one with an alarm is read as itself', () => {
    const ics = `${withAlarms(DISPLAY_ALARM)}\r\nBEGIN:VEVENT\r\nSUMMARY:Dentist\r\nDTSTART:20260601T090000Z\r\nEND:VEVENT`;
    expect(parseICS(ics).map((e) => [e.title, e.description])).toEqual([
      ['Soccer practice', 'Bring water and shin guards'],
      ['Dentist', null],
    ]);
  });
});

describe('an event the importer cannot place is counted, not lost without a word', () => {
  it('an event with no SUMMARY is imported untitled, as one with an empty SUMMARY already was', () => {
    const ics = 'BEGIN:VEVENT\nDTSTART:20260601T090000Z\nEND:VEVENT';
    expect(parseICSReport(ics)).toEqual({
      events: [{ title: 'Untitled event', startsAt: '2026-06-01T09:00:00.000Z', endsAt: null, allDay: false, location: null, description: null }],
      skipped: 0,
    });
    expect(parseICS('BEGIN:VEVENT\nSUMMARY:\nDTSTART:20260601T090000Z\nEND:VEVENT')[0].title).toBe('Untitled event');
  });

  it('an event with no readable start is left out and counted', () => {
    const ics = [
      'BEGIN:VEVENT', 'SUMMARY:No start at all', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Unreadable start', 'DTSTART:sometime in June', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Dentist', 'DTSTART:20260601T090000Z', 'END:VEVENT',
    ].join('\n');
    const report = parseICSReport(ics);
    expect(report.events.map((e) => e.title)).toEqual(['Dentist']);
    expect(report.skipped).toBe(2);
  });

  it('a clean export reports nothing skipped, and parseICS is the same events', () => {
    const ics = withAlarms(DISPLAY_ALARM);
    expect(parseICSReport(ics)).toEqual({ events: [OWN], skipped: 0 });
    expect(parseICS(ics)).toEqual(parseICSReport(ics).events);
  });
});
