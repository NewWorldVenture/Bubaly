import { describe, expect, it } from 'vitest';
import {
  createTransactionIntent, readTransactionOperationReply, transactionIntentFromToolInputs,
} from '@/lib/services/finances/transaction-operation';

describe('version 1 transaction intent', () => {
  it('normalizes tool and service inputs identically without changing requested amounts', () => {
    const input = Object.freeze({
      name: ' Coffee ', amount: 4.504, merchant: ' Blue Bottle ', category: ' Dining ',
      date: ' 2026-09-05 ', notes: ' Receipt split ', accountId: 'acct-1',
      memberId: 'member-2', receiptDocumentId: 'doc-1', source: 'ai',
    });
    const expected = {
      version: 1, name: 'Coffee', requestedAmount: 4.504, type: 'expense', merchant: 'Blue Bottle',
      category: 'Dining', date: '2026-09-05', notes: 'Receipt split', accountId: 'acct-1',
      memberId: 'member-2', receiptDocumentId: 'doc-1', source: 'ai',
    };
    expect(createTransactionIntent(input, 'ai')).toEqual(expected);
    expect(transactionIntentFromToolInputs({
      receipt_document_id: 'doc-1', member_id: 'member-2', account_id: 'acct-1',
      name: 'Coffee', amount: 4.504, type: null, merchant: 'Blue Bottle', category: 'Dining',
      date: '2026-09-05', notes: 'Receipt split',
    }, 'ai')).toEqual(expected);
    expect(input.amount).toBe(4.504);
    expect(input.name).toBe(' Coffee ');
  });

  it('keeps an omitted date unresolved and normalizes blank optional text', () => {
    const expected = createTransactionIntent({ name: 'Coffee', amount: 4.5 }, 'ai');
    expect(expected).toMatchObject({
      version: 1, date: null, type: 'expense', merchant: null, category: null, notes: null,
      accountId: null, memberId: null, receiptDocumentId: null,
    });
    expect(transactionIntentFromToolInputs({ name: 'Coffee', amount: 4.5, date: ' ', merchant: '', category: null, notes: ' ' }, 'ai')).toEqual(expected);
    expect(createTransactionIntent({ name: 'Coffee', amount: 4.5, date: '2026-09-05' }, 'ai')).not.toEqual(expected);
  });

  it('distinguishes requests that would round to the same stored amount', () => {
    expect(createTransactionIntent({ name: 'Coffee', amount: 4.504 }, 'ai'))
      .not.toEqual(createTransactionIntent({ name: 'Coffee', amount: 4.5 }, 'ai'));
  });

  it('does not trim or replace supplied foreign-key strings', () => {
    expect(createTransactionIntent({ name: 'Coffee', amount: 4.5, accountId: ' acct-1 ', memberId: '' }, 'ai'))
      .toMatchObject({ accountId: ' acct-1 ', memberId: '', receiptDocumentId: null });
  });

  it.each([['ai', 'ai'], ['member', 'manual'], ['system', 'manual']] as const)('defaults source for %s actors to %s', (actorKind, source) => {
    expect(createTransactionIntent({ name: 'Coffee', amount: 4.5 }, actorKind).source).toBe(source);
  });

  it.each([
    [null], [[]], [{}], [{ name: 'Coffee', amount: '4.50' }],
    [{ name: 'Coffee', amount: Number.POSITIVE_INFINITY }],
    [{ name: 'Coffee', amount: 4.5, type: 'payment' }],
    [{ name: 'Coffee', amount: 4.5, account_id: 12 }],
    [{ name: 'Coffee', amount: 4.5, source: 'receipt' }],
    [{ name: 'Coffee', amount: 4.5, unknown_action: true }],
  ])('refuses unsupported stored tool inputs: %j', (inputs) => {
    expect(transactionIntentFromToolInputs(inputs, 'ai')).toBeNull();
  });
});

describe('operation reply validation', () => {
  const transaction = { id: 'txn-1', family_id: 'fam-1', name: 'Coffee', amount: 4.5, type: 'expense', date: '2026-09-05', merchant: null };

  it.each(['unchanged', 'edited', 'deleted'] as const)('accepts the original row for a %s replay', (recordState) => {
    const reply = { transaction, replayed: true, recordState };
    expect(readTransactionOperationReply(reply, 'fam-1')).toEqual(reply);
  });

  it('rejects a cross-family result and an impossible first-write state', () => {
    expect(readTransactionOperationReply({ transaction, replayed: true, recordState: 'unchanged' }, 'other-family')).toBeNull();
    expect(readTransactionOperationReply({ transaction, replayed: false, recordState: 'deleted' }, 'fam-1')).toBeNull();
    expect(readTransactionOperationReply(null, 'fam-1')).toBeNull();
  });
});
