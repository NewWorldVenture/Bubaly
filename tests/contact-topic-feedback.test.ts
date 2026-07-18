import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contactSchema, CONTACT_TOPICS, contactTopicLabel } from '../lib/validation';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('contact — topic dropdown', () => {
  it('offers common reasons including a bug report and a feature request', () => {
    const values = CONTACT_TOPICS.map((t) => t.value);
    expect(values).toEqual(expect.arrayContaining(['general', 'bug', 'feature', 'billing', 'account', 'feedback']));
    expect(contactTopicLabel('bug').toLowerCase()).toContain('bug');
  });

  it('validates + defaults the topic', () => {
    expect(contactSchema.safeParse({ name: 'Jo', email: 'a@b.co', message: 'hello there!!' }).success).toBe(true);
    const parsed = contactSchema.parse({ name: 'Jo', email: 'a@b.co', message: 'hello there!!' });
    expect(parsed.topic).toBe('general');
    expect(contactSchema.safeParse({ name: 'Jo', email: 'a@b.co', topic: 'nope', message: 'hello there!!' }).success).toBe(false);
  });

  it('the form renders the topic select and submits it', () => {
    const form = read('components/marketing/contact-form.tsx');
    expect(form).toMatch(/name="topic"/);
    expect(form).toMatch(/CONTACT_TOPICS\.map/);
    expect(form).toMatch(/topic: String\(form\.get\('topic'\)/);
  });

  it('the API routes the topic into the support ticket (category + subject)', () => {
    const route = read('app/api/contact/route.ts');
    expect(route).toMatch(/category: topic/);
    expect(route).toMatch(/\[\$\{topicLabel\}\]/);
    expect(route).toMatch(/topic === 'bug' \? 'high'/); // bugs triaged faster
  });
});

describe('contact — "Feedback is a gift" block', () => {
  const page = read('app/(marketing)/contact/page.tsx');

  it('adds the warm feedback CTA', () => {
    expect(page).toMatch(/Feedback is a gift/);
    expect(page).toMatch(/enhancement request/i);
  });

  it('shows the gift icon + in-app link only when logged in, login prompt otherwise', () => {
    expect(page).toMatch(/const loggedIn = !!user/);
    expect(page).toMatch(/loggedIn \? <Gift/);        // gift icon once logged in
    expect(page).toMatch(/href="\/feedback"/);          // logged-in submits enhancement requests
    expect(page).toMatch(/\/login\?redirect=%2Ffeedback/); // logged-out is invited to log in
  });
});
