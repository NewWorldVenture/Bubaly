// M29 — the importer can read a contacts export.
//
// Before this the migrate wizard took ICS and CSV lists only, so a family
// leaving Cozi or FamilyWall carried its calendar across and re-typed every
// babysitter, coach and grandparent by hand. These cases pin the two formats
// every address book actually exports (vCard and a contacts CSV) and the
// dedupe that keeps one person from arriving three times.
import { describe, expect, it } from 'vitest';
import {
  parseVCard, parseCSV, csvToContacts, dedupeContacts,
  normalizeEmail, normalizePhone, contactKeys,
} from '@/lib/migrate/parse';

const VCARD = `BEGIN:VCARD
VERSION:3.0
FN:Grandma Rose
N:Rose;Grandma;;;
TEL;TYPE=CELL:(555) 010-1234
EMAIL;TYPE=INTERNET:rose@example.com
ORG:Retired;
NOTE:Emergency contact for the kids
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Alvarez;Coach Dani;;;
item1.TEL;type=WORK:+1 555 010 9999
item1.EMAIL;type=INTERNET:dani@soccer.example
END:VCARD
BEGIN:VCARD
VERSION:2.1
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Anna M=C3=BCller
TEL:555-010-4444
END:VCARD
BEGIN:VCARD
VERSION:3.0
TEL:555-010-7777
END:VCARD`;

describe('parseVCard', () => {
  it('reads FN, phone, email, org and note from a 3.0 card', () => {
    const [rose] = parseVCard(VCARD);
    expect(rose.name).toBe('Grandma Rose');
    expect(rose.phones).toEqual(['(555) 010-1234']);
    expect(rose.emails).toEqual(['rose@example.com']);
    expect(rose.organization).toBe('Retired');
    expect(rose.notes).toBe('Emergency contact for the kids');
  });

  it('falls back to the structured N property when there is no FN', () => {
    const dani = parseVCard(VCARD)[1];
    expect(dani.name).toBe('Coach Dani Alvarez');
  });

  it('reads properties that carry a group prefix and parameters', () => {
    const dani = parseVCard(VCARD)[1];
    expect(dani.phones).toEqual(['+1 555 010 9999']);
    expect(dani.emails).toEqual(['dani@soccer.example']);
  });

  it('decodes quoted-printable names rather than importing mojibake', () => {
    const anna = parseVCard(VCARD)[2];
    expect(anna.name).toBe('Anna Müller');
  });

  it('drops a card with no name at all', () => {
    // Four BEGIN:VCARD blocks, three of them named.
    expect(parseVCard(VCARD)).toHaveLength(3);
    expect(parseVCard(VCARD).every((c) => c.name.trim().length > 0)).toBe(true);
  });

  it('unfolds continued lines and survives CRLF', () => {
    const folded = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A Very Long\r\n  Name Indeed\r\nTEL:5550101111\r\nEND:VCARD\r\n';
    const [c] = parseVCard(folded);
    expect(c.name).toBe('A Very Long Name Indeed');
  });

  it('returns nothing for a document with no cards', () => {
    expect(parseVCard('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([]);
  });
});

describe('csvToContacts', () => {
  it('maps an Outlook export with separate name columns', () => {
    const table = parseCSV(
      'First Name,Last Name,E-mail Address,Phone Number,Organization,Notes\n'
      + 'Dana,Kim,dana@example.com,555-010-2222,Riverside School,Class teacher\n',
    );
    const [dana] = csvToContacts(table);
    expect(dana.name).toBe('Dana Kim');
    expect(dana.emails).toEqual(['dana@example.com']);
    expect(dana.phones).toEqual(['555-010-2222']);
    expect(dana.organization).toBe('Riverside School');
    expect(dana.notes).toBe('Class teacher');
  });

  // Google Contacts writes the label BEFORE the value ("E-mail 1 - Type" then
  // "E-mail 1 - Value"), and a substring match on "e-mail"/"phone" reached the
  // label first: every row imported the address "*" and the number "Mobile",
  // which then gave the whole export one identity key and collapsed it to a
  // single person. This is that export's real header row.
  it('reads the value columns of a real Google Contacts export, not the labels', () => {
    const table = parseCSV(
      'Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value\n'
      + 'Dana Kim,Dana,Kim,*,dana@example.com,Mobile,555-010-2222\n'
      + 'Sam Ray,Sam,Ray,*,sam@example.com,Work,555-010-3333\n'
      + 'Coach Dani,Dani,Alvarez,Home,dani@soccer.example,Mobile,555-010-9999\n',
    );
    const contacts = csvToContacts(table);
    expect(contacts.map((c) => c.name)).toEqual(['Dana Kim', 'Sam Ray', 'Coach Dani']);
    expect(contacts.map((c) => c.emails)).toEqual([
      ['dana@example.com'], ['sam@example.com'], ['dani@soccer.example'],
    ]);
    expect(contacts.map((c) => c.phones)).toEqual([
      ['555-010-2222'], ['555-010-3333'], ['555-010-9999'],
    ]);

    // and three different people survive the dedupe as three people
    const deduped = dedupeContacts(contacts);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((c) => c.name)).toEqual(['Dana Kim', 'Sam Ray', 'Coach Dani']);
  });

  it('does not write one phone column into both phone and phone_alt', () => {
    // "Home Phone" answers the phone candidates and the phone-alt candidates,
    // so the number used to arrive twice — and commitImport writes phones[1]
    // to family_contacts.phone_alt, showing the same number on the card twice.
    const [sam] = csvToContacts(parseCSV('Name,Home Phone\nSam Ray,555-010-8888\n'));
    expect(sam.phones).toEqual(['555-010-8888']);
  });

  it('lists a number once when two columns carry the same number', () => {
    const [pat] = csvToContacts(parseCSV(
      'Name,Phone,Work Phone\nPat Lee,(555) 010-4444,+1 555-010-4444\n',
    ));
    expect(pat.phones).toEqual(['(555) 010-4444']);
  });

  it('prefers a single name column and splits multi-valued cells', () => {
    const table = parseCSV(
      'Name,Email,Phone,Home Phone\n'
      + '"Sam Ray","sam@example.com; sam.ray@work.example","555-010-3333","555-010-8888"\n',
    );
    const [sam] = csvToContacts(table);
    expect(sam.name).toBe('Sam Ray');
    expect(sam.emails).toEqual(['sam@example.com', 'sam.ray@work.example']);
    expect(sam.phones).toEqual(['555-010-3333', '555-010-8888']);
  });

  it('skips rows with no name rather than importing blanks', () => {
    const table = parseCSV('Name,Email\n,orphan@example.com\nReal Person,real@example.com\n');
    expect(csvToContacts(table).map((c) => c.name)).toEqual(['Real Person']);
  });

  it('returns nothing for a header-only file', () => {
    expect(csvToContacts(parseCSV('Name,Email\n'))).toEqual([]);
  });
});

describe('identity normalisation', () => {
  it('lower-cases and trims emails', () => {
    expect(normalizeEmail('  Rose@Example.COM ')).toBe('rose@example.com');
    expect(normalizeEmail(null)).toBe('');
  });

  it('reduces a phone to its last ten digits, whatever the punctuation', () => {
    expect(normalizePhone('(555) 010-1234')).toBe('5550101234');
    expect(normalizePhone('+1 555 010 1234')).toBe('5550101234');
    expect(normalizePhone('5550101234')).toBe('5550101234');
  });

  it('refuses to treat a fragment as an identity', () => {
    expect(normalizePhone('x204')).toBe('');
    expect(normalizePhone('')).toBe('');
  });

  it('lists an email key and a phone key per contact', () => {
    expect(contactKeys({ emails: ['A@B.com'], phones: ['555-010-1234', 'x9'] }))
      .toEqual(['email:a@b.com', 'phone:5550101234']);
  });
});

describe('dedupeContacts', () => {
  it('merges two cards that share a phone, keeping the union of details', () => {
    const merged = dedupeContacts([
      { name: 'Grandma Rose', emails: [], phones: ['(555) 010-1234'], organization: null, notes: null },
      { name: 'Rose', emails: ['rose@example.com'], phones: ['+1 555 010 1234'], organization: 'Retired', notes: 'Nana' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Grandma Rose');       // first name seen wins
    expect(merged[0].emails).toEqual(['rose@example.com']);
    expect(merged[0].phones).toEqual(['(555) 010-1234']); // the same number is not added twice
    expect(merged[0].organization).toBe('Retired');
    expect(merged[0].notes).toBe('Nana');
  });

  it('merges on a shared email even when the phones differ', () => {
    const merged = dedupeContacts([
      { name: 'Dana Kim', emails: ['dana@example.com'], phones: ['555-010-2222'], organization: null, notes: null },
      { name: 'D. Kim', emails: ['DANA@example.com'], phones: ['555-010-5555'], organization: null, notes: null },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].phones).toEqual(['555-010-2222', '555-010-5555']);
  });

  it('keeps two different people apart', () => {
    const merged = dedupeContacts([
      { name: 'Dana Kim', emails: ['dana@example.com'], phones: [], organization: null, notes: null },
      { name: 'Sam Ray', emails: ['sam@example.com'], phones: [], organization: null, notes: null },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('falls back to an exact name match only when there is nothing else to compare', () => {
    const merged = dedupeContacts([
      { name: 'Babysitter', emails: [], phones: [], organization: null, notes: null },
      { name: 'babysitter', emails: [], phones: [], organization: null, notes: null },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('does not fold two same-named people who have different contact details', () => {
    const merged = dedupeContacts([
      { name: 'Alex', emails: ['alex.one@example.com'], phones: [], organization: null, notes: null },
      { name: 'Alex', emails: ['alex.two@example.com'], phones: [], organization: null, notes: null },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('round-trips a vCard document through the dedupe unchanged when everyone is distinct', () => {
    expect(dedupeContacts(parseVCard(VCARD))).toHaveLength(3);
  });
});
