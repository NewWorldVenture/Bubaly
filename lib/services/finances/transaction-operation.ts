import type { ServiceScope } from '../types';
import type { CreateTransactionInput, TransactionRow } from './index';

export const FINANCE_TRANSACTION_TOOL_NAME = 'finances.createTransaction';

export type TransactionOperationMetadata = {
  replayed: boolean;
  recordState: 'unchanged' | 'edited' | 'deleted';
};

export type TransactionOperationReply = TransactionOperationMetadata & {
  transaction: TransactionRow;
};

/** Intent preserves the requested amount and an unresolved default date. */
export function createTransactionIntent(input: CreateTransactionInput, actorKind: ServiceScope['actorKind']) {
  return {
    version: 1 as const,
    name: input.name.trim(),
    requestedAmount: input.amount,
    type: input.type ?? 'expense',
    merchant: input.merchant?.trim() || null,
    category: input.category?.trim() || null,
    date: input.date?.trim() || null,
    notes: input.notes?.trim() || null,
    accountId: input.accountId ?? null,
    memberId: input.memberId ?? null,
    receiptDocumentId: input.receiptDocumentId ?? null,
    source: input.source?.trim() || (actorKind === 'ai' ? 'ai' : 'manual'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const OPTIONAL_TOOL_STRINGS = ['merchant', 'category', 'date', 'notes', 'account_id', 'member_id', 'receipt_document_id'] as const;
const TOOL_FIELDS = new Set<string>(['name', 'amount', 'type', ...OPTIONAL_TOOL_STRINGS]);

/** Map the stored, tool-shaped arguments through the same intent normalizer. */
export function transactionIntentFromToolInputs(inputs: unknown, actorKind: ServiceScope['actorKind']) {
  if (!isRecord(inputs) || Object.keys(inputs).some((key) => !TOOL_FIELDS.has(key))) return null;
  if (typeof inputs.name !== 'string' || !inputs.name.trim()) return null;
  if (typeof inputs.amount !== 'number' || !Number.isFinite(inputs.amount) || inputs.amount <= 0) return null;
  if (inputs.type != null && inputs.type !== 'income' && inputs.type !== 'expense' && inputs.type !== 'transfer') return null;
  if (OPTIONAL_TOOL_STRINGS.some((key) => inputs[key] != null && typeof inputs[key] !== 'string')) return null;

  return createTransactionIntent({
    name: inputs.name,
    amount: inputs.amount,
    type: (inputs.type ?? undefined) as CreateTransactionInput['type'],
    merchant: inputs.merchant as string | null | undefined,
    category: inputs.category as string | null | undefined,
    date: inputs.date as string | null | undefined,
    notes: inputs.notes as string | null | undefined,
    accountId: inputs.account_id as string | null | undefined,
    memberId: inputs.member_id as string | null | undefined,
    receiptDocumentId: inputs.receipt_document_id as string | null | undefined,
  }, actorKind);
}

/** Validate the RPC fields used for the financial result and its summary. */
export function readTransactionOperationReply(value: unknown, familyId: string): TransactionOperationReply | null {
  if (!isRecord(value) || typeof value.replayed !== 'boolean') return null;
  const recordState = value.recordState;
  if (recordState !== 'unchanged' && recordState !== 'edited' && recordState !== 'deleted') return null;
  if (!value.replayed && recordState !== 'unchanged') return null;
  const row = value.transaction;
  if (!isRecord(row) || row.family_id !== familyId) return null;
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()) return null;
  if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0) return null;
  if (row.type !== 'income' && row.type !== 'expense' && row.type !== 'transfer') return null;
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  if (row.merchant !== null && typeof row.merchant !== 'string') return null;
  return { transaction: row as unknown as TransactionRow, replayed: value.replayed, recordState };
}
