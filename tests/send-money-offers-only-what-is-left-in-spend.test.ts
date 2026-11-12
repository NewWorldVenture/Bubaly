// Send Money tells a parent how much each child's wallet has "available" to
// send, and bounds the amount they may enter by that figure. A transfer takes
// the money from the sender's Spend bucket only, and counts a live card hold
// against it (wallet_transfer and wallet_spendable_cents, 0483). The page hands
// the view that figure as `spendBalance`: Spend less live holds (N6).
//
// The view fell back to the wallet's TOTAL whenever that figure was not
// positive, in the figure it showed and in the bound alike. A child with $10 in
// Spend, a live $10 card hold and $50 in Save was offered as "$60 available",
// and the parent could enter up to $60, which the transfer then refused ("Only
// 0.00 is available."). A child with nothing in Spend was offered their Save,
// Give and Invest money, which no transfer takes.
//
// The figure and the bound are now Spend less live holds, never below zero.
//
// Review item CMS-REV-1 (child-money-scope, on N6). Driven through the REAL
// SendMoneyView (tests/helpers/module-harness.tsx): its steps, its keypad and
// its Continue button. The transfer action is the one seam; nothing here
// reaches it.
import { createElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byName, click, has, nodes, render, text, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { formatCents } from '@/lib/wallet/ledger';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const sendMoneyAction = vi.hoisted(() => vi.fn());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/wallet/actions', () => ({ sendMoneyAction }));

const { SendMoneyView } = await import('@/components/wallet/send-money-view');
type SendChild = Parameters<typeof SendMoneyView>[0]['wallets'][number];

/** $10 in Spend, a live $10 card hold on it, and $50 in Save. */
const ARI: SendChild = { id: 'cw-ari', name: 'Ari', color: null, spendBalance: 0, total: 6_000 };
/** $15 in Spend with no hold, and $25 more in the other buckets. */
const BEN: SendChild = { id: 'cw-ben', name: 'Ben', color: null, spendBalance: 1_500, total: 4_000 };
/** Holds that outran Spend by $6, and $40 in the other buckets. */
const CAL: SendChild = { id: 'cw-cal', name: 'Cal', color: null, spendBalance: -600, total: 4_000 };

let element: ReactElement;
let tree: ReactNode;
const draw = () => (tree = render(h.hooks, element));

function open(wallets: SendChild[]): void {
  resetHookSlots(h.hooks);
  element = createElement(SendMoneyView, { wallets, canManage: true });
  draw();
}

/** The button on the current step that names this child. */
function walletButton(name: string): Node {
  const found = nodes(tree).filter((node) => node.type === 'button'
    && nodes(node.props.children as ReactNode).some((child) => child.type === 'p' && text(child) === name));
  expect(found, `one button for ${name}`).toHaveLength(1);
  return found[0];
}

/** Tap a child's wallet on the current step, as a parent does. */
async function pick(name: string): Promise<void> {
  await click(walletButton(name));
  draw();
}

/** Type an amount on the keypad, a key at a time. */
async function enter(amount: string): Promise<void> {
  for (const key of amount) {
    await click(byName(tree, key, 'button'));
    draw();
  }
}

const continueButton = () => byName(tree, 'Continue', 'button');

beforeEach(() => {
  sendMoneyAction.mockReset();
});

describe('Send Money offers only what is left in Spend', () => {
  it('a wallet whose Spend is all held is offered as $0 available, not as its savings', () => {
    open([ARI, BEN]);

    expect(text(walletButton('Ari'))).toContain(`${formatCents(0)} available`);
    expect(text(walletButton('Ari'))).not.toContain(`${formatCents(6_000)} available`);
    expect(text(walletButton('Ben'))).toContain(`${formatCents(1_500)} available`);
  });

  it('once picked, it is still named with $0, and not a cent of its total can be entered', async () => {
    open([ARI, BEN]);
    await pick('Ari');

    expect(has(tree, `Ari · ${formatCents(0)}`)).toBe(true);
    expect(has(tree, `Ari · ${formatCents(6_000)}`)).toBe(false);
    await pick('Ben');
    await enter('0.01');
    expect(continueButton().props.disabled).toBe(true);
    expect(has(tree, 'Insufficient balance')).toBe(true);
  });

  it('$20 of its $60 total cannot be sent either', async () => {
    open([ARI, BEN]);
    await pick('Ari');
    await pick('Ben');

    await enter('20');

    expect(continueButton().props.disabled).toBe(true);
    expect(has(tree, 'Insufficient balance')).toBe(true);
  });

  it('a wallet with Spend to send is bounded by exactly that Spend', async () => {
    open([ARI, BEN]);
    await pick('Ben');

    expect(has(tree, `Ben · ${formatCents(1_500)}`)).toBe(true);
    await pick('Ari');
    await enter('15');
    expect(continueButton().props.disabled).toBe(false);
    await enter('.01');
    expect(continueButton().props.disabled).toBe(true);
  });

  it('Spend overdrawn by holds is offered as $0, never as a negative figure or the total', async () => {
    open([CAL, BEN]);

    expect(text(walletButton('Cal'))).toContain(`${formatCents(0)} available`);
    expect(text(walletButton('Cal'))).not.toContain(`${formatCents(4_000)} available`);
    await pick('Cal');
    expect(has(tree, `Cal · ${formatCents(0)}`)).toBe(true);
    await pick('Ben');
    await enter('0.01');
    expect(continueButton().props.disabled).toBe(true);
  });
});
