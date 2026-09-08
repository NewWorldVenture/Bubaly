// Top family-organizer competitors and how to export from each. Every one of
// these offers an ICS calendar export and/or CSV lists, which the importer
// ingests — so the migration genuinely works end to end.

export type ImportFormat = 'ics' | 'csv';

export type Competitor = {
  key: string;
  name: string;
  blurb: string;
  accent: string;       // tailwind bg for the logo chip
  transfers: string[];  // what comes across
  formats: ImportFormat[];
  steps: string[];      // how to export from the source app
};

export const COMPETITORS: Competitor[] = [
  {
    key: 'cozi',
    name: 'Cozi',
    blurb: 'The most popular shared family calendar.',
    accent: 'bg-emerald-600',
    transfers: ['Calendar events', 'To-do & shopping lists'],
    formats: ['ics', 'csv'],
    steps: [
      'Open Cozi on the web at my.cozi.com and sign in.',
      'Go to Settings → Calendar and copy your ICS / iCal feed URL (or “Export”).',
      'Open the ICS URL in your browser and save the .ics file.',
      'For lists, open a list → ⋯ → Export, or copy items into a .csv.',
    ],
  },
  {
    key: 'familywall',
    name: 'FamilyWall',
    blurb: 'Calendar, lists, and family location in one app.',
    accent: 'bg-blue-600',
    transfers: ['Calendar events', 'Shopping & task lists'],
    formats: ['ics', 'csv'],
    steps: [
      'Open FamilyWall on the web and go to the Calendar.',
      'Open Calendar settings → Sync / Export and copy the iCal (ICS) link.',
      'Open the link to download the .ics file.',
      'Export lists as CSV from the Lists section if available.',
    ],
  },
  {
    key: 'google',
    name: 'Google Calendar',
    blurb: 'Move your existing Google family calendar over.',
    accent: 'bg-rose-600',
    transfers: ['Calendar events'],
    formats: ['ics'],
    steps: [
      'Open Google Calendar on the web (calendar.google.com).',
      'Settings (gear) → Settings → Import & export.',
      'Under “Export”, click Export — you’ll get a .zip.',
      'Unzip it and upload the .ics file for your family calendar.',
    ],
  },
  {
    key: 'apple',
    name: 'Apple Calendar',
    blurb: 'Bring your iCloud family calendar with you.',
    accent: 'bg-zinc-600',
    transfers: ['Calendar events'],
    formats: ['ics'],
    steps: [
      'Open the Calendar app on your Mac.',
      'Select the family calendar in the sidebar.',
      'File → Export → Export… and save the .ics file.',
      'Upload that .ics file here.',
    ],
  },
  {
    key: 'ourhome',
    name: 'OurHome',
    blurb: 'Chores, rewards, groceries and a shared calendar.',
    accent: 'bg-amber-600',
    transfers: ['Tasks & chores', 'Grocery lists', 'Calendar (ICS)'],
    formats: ['ics', 'csv'],
    steps: [
      'Open OurHome and go to your Lists / Tasks.',
      'Export each list to CSV (or copy rows into a spreadsheet → Save as CSV).',
      'If you sync a calendar, export it as an .ics file.',
      'Upload the .csv and/or .ics files here.',
    ],
  },
];

export const competitorByKey = (key: string) => COMPETITORS.find((c) => c.key === key);

export type ImportTarget = 'events' | 'tasks' | 'grocery' | 'notes' | 'contacts';

/** English label + the catalogue key the UI renders it through. */
export const TARGET_LABELS: Record<ImportTarget, { label: string; labelKey: string }> = {
  events: { label: 'Calendar events', labelKey: 'migrateWizard.targetEvents' },
  tasks: { label: 'Tasks & chores', labelKey: 'migrateWizard.targetTasks' },
  grocery: { label: 'Grocery items', labelKey: 'migrateWizard.targetGrocery' },
  notes: { label: 'Notes', labelKey: 'migrateWizard.targetNotes' },
  contacts: { label: 'Contacts', labelKey: 'migrateWizard.targetContacts' },
};

// Likely CSV header names per target, for auto-mapping. Contacts have their own
// multi-column mapping (`csvToContacts`) — this entry is the fallback name
// column only, so the target list stays complete.
export const CSV_NAME_COLUMNS: Record<ImportTarget, string[]> = {
  events: ['subject', 'title', 'name', 'event'],
  tasks: ['task', 'title', 'name', 'chore', 'to-do', 'todo', 'item'],
  grocery: ['item', 'name', 'product', 'grocery'],
  notes: ['note', 'title', 'name', 'text'],
  contacts: ['name', 'full name', 'display name', 'contact name'],
};
