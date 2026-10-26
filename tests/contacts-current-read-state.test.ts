import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { change, click, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Actual ContactsModule and read-only selection UI. Synthetic query states
// model the documented hook contract; no Auth/cache/coordinator is mounted.
// SDK and mutation dispatches refuse, so these are not contact-write tests.
const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
type ReadState = { data: Record<string, unknown>[]; loading: boolean; stale: boolean; error: string | null };
const live = vi.hoisted(() => ({ read: { data: [], loading: false, stale: false, error: null } as ReadState, refreshes: 0 }));
vi.mock('react', async original => (await import('./helpers/hook-slots')).withHookSlots(await original<typeof import('react')>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => {
  if (table !== 'family_contacts') throw new Error('Unexpected read');
  return { ...live.read, refresh: async () => { live.refreshes++; live.read = { ...live.read, loading: false, stale: false, error: null }; } };
} }));
vi.mock('@/lib/hooks/use-action', () => ({ useAction: () => ({ isPending: () => false, run: () => { throw new Error('Unexpected mutation dispatch'); } }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('Unexpected SDK call'); } }));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/ui/states', () => ({
  SkeletonList: () => createElement('div', { role: 'status' }, 'Awaiting verified contacts'),
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => createElement('div', { role: 'alert' },
    message, createElement('button', { onClick: onRetry }, 'Retry contacts')),
  EmptyState: ({ title }: { title: string }) => createElement('div', { 'data-empty': true }, title),
}));
const { ContactsModule } = await import('@/components/modules/contacts-module');
const NAME = 'Synthetic doctor';
const OLD_PHONE = '+15550000001';
const NEW_PHONE = '+15550000002';
const row = (values: Record<string, unknown> = {}) => ({ id: 'contact-1', family_id: h.app.familyId,
  name: NAME, phone: OLD_PHONE, category: 'doctor', is_emergency: true, relationship: '', ...values });
const show = () => render(h.hooks, createElement(ContactsModule));
const hasRole = (role: string) => nodes(show()).some(node => node.props.role === role);
const hasEmpty = () => nodes(show()).some(node => node.props['data-empty']);
async function selectDoctor() {
  const button = nodes(show()).find(node => node.type === 'button' && node.props['aria-expanded'] === false && text(node).includes(NAME));
  if (!button) throw new Error('Missing verified contact selection control');
  await click(button);
  expect(nodes(show()).some(node => node.props['aria-expanded'] === true)).toBe(true);
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  live.read = { data: [row()], loading: false, stale: false, error: null };
  live.refreshes = 0;
});

describe('contacts show only their current verified read', () => {
  it('shows a verified emergency contact and its phone', () => {
    expect(text(show())).toContain(NAME);
    expect(text(show())).toContain(OLD_PHONE);
    expect(hasRole('status')).toBe(false);
    expect(hasRole('alert')).toBe(false);
  });
  it('allows a verified empty contact book to show its empty state', () => {
    live.read.data = [];
    expect(hasEmpty()).toBe(true);
    expect(hasRole('status')).toBe(false);
  });
  it('hides cached names and emergency phones during initial loading', () => {
    live.read.loading = true;
    expect(hasRole('status')).toBe(true);
    expect(text(show())).not.toContain(NAME);
    expect(text(show())).not.toContain(OLD_PHONE);
  });
  it('hides cached names and emergency phones until the stale read is verified', () => {
    live.read.stale = true;
    expect(hasRole('status')).toBe(true);
    expect(text(show())).not.toContain(NAME);
    expect(text(show())).not.toContain(OLD_PHONE);
  });
  it('does not mistake an unverified empty cache for an empty contact book', () => {
    live.read.data = []; live.read.stale = true;
    expect(hasRole('status')).toBe(true);
    expect(hasEmpty()).toBe(false);
  });
  it('shows an actionable failed read instead of cached contact details', () => {
    live.read.error = 'Synthetic read unavailable'; live.read.stale = true;
    expect(hasRole('alert')).toBe(true);
    expect(text(show())).toContain('Synthetic read unavailable');
    expect(text(show())).not.toContain(OLD_PHONE);
  });
  it('does not hide a known read error behind a loading flag', () => {
    live.read.error = 'Synthetic read unavailable'; live.read.loading = true; live.read.stale = true;
    expect(hasRole('alert')).toBe(true);
    expect(hasRole('status')).toBe(false);
  });
  it('retry re-reads and reveals a verified healthy contact', async () => {
    live.read.error = 'Synthetic read unavailable'; live.read.stale = true;
    const retry = nodes(show()).find(node => node.type === 'button' && text(node) === 'Retry contacts')!;
    await click(retry);
    expect(live.refreshes).toBe(1);
    expect(text(show())).toContain(OLD_PHONE);
    expect(hasRole('alert')).toBe(false);
  });
  it('updates selected contact details from a same-family fresh row', async () => {
    await selectDoctor();
    live.read.data = [row({ phone: NEW_PHONE, name: 'Updated synthetic doctor' })];
    expect(text(show())).toContain(NEW_PHONE);
    expect(text(show())).not.toContain(OLD_PHONE);
    expect(text(show())).not.toContain(NAME);
    expect(nodes(show()).some(node => node.props['aria-expanded'] === true)).toBe(true);
  });
  it('removes deleted selection details while retaining another verified contact', async () => {
    await selectDoctor();
    live.read.data = [row({ id: 'contact-2', name: 'Another synthetic doctor', phone: NEW_PHONE })];
    expect(text(show())).not.toContain(NAME);
    expect(text(show())).not.toContain(OLD_PHONE);
    expect(text(show())).toContain('Another synthetic doctor');
    expect(nodes(show()).some(node => node.props['aria-expanded'] === true)).toBe(false);
  });
  it('preserves the selected current row when an unrelated row changes', async () => {
    await selectDoctor();
    live.read.data = [row(), row({ id: 'contact-2', name: 'Another synthetic doctor', phone: NEW_PHONE })];
    expect(text(show())).toContain(OLD_PHONE);
    expect(nodes(show()).filter(node => node.props['aria-expanded'] === true)).toHaveLength(1);
  });
  it('preserves search state across verification without displaying cached rows', () => {
    const input = nodes(show()).find(node => node.type === 'input' && typeof node.props.onChange === 'function')!;
    change(input, 'Synthetic');
    live.read.stale = true;
    expect(text(show())).not.toContain(OLD_PHONE);
    live.read.stale = false;
    expect(nodes(show()).find(node => node.type === 'input')?.props.value).toBe('Synthetic');
    expect(text(show())).toContain(OLD_PHONE);
  });
});
