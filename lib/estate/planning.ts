import type { EstateDocumentType, EstateReviewStatus } from '@/lib/database.types';

export const DOCUMENT_TYPES: { value: EstateDocumentType; label: string; emoji: string }[] = [
  { value: 'will', label: 'Will', emoji: '📜' },
  { value: 'trust', label: 'Trust', emoji: '🏦' },
  { value: 'power_of_attorney', label: 'Power of Attorney', emoji: '⚖️' },
  { value: 'advance_directive', label: 'Advance Directive', emoji: '🩺' },
  { value: 'beneficiary_designation', label: 'Beneficiary Designation', emoji: '👤' },
  { value: 'insurance_policy', label: 'Insurance Policy', emoji: '🛡️' },
  { value: 'deed', label: 'Deed', emoji: '🏠' },
  { value: 'title', label: 'Title', emoji: '🚗' },
  { value: 'digital_account', label: 'Digital Account', emoji: '💻' },
  { value: 'letter_of_intent', label: 'Letter of Intent', emoji: '✉️' },
  { value: 'funeral_wishes', label: 'Funeral Wishes', emoji: '🕊️' },
  { value: 'other', label: 'Other', emoji: '📄' },
];

export const REVIEW_STATUSES: { value: EstateReviewStatus; label: string }[] = [
  { value: 'current', label: 'Current' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'expired', label: 'Expired' },
  { value: 'draft', label: 'Draft' },
];

export function docTypeMeta(t: EstateDocumentType) {
  return DOCUMENT_TYPES.find((x) => x.value === t) ?? DOCUMENT_TYPES[DOCUMENT_TYPES.length - 1];
}

export function dayDiff(a: string | Date, b: string | Date): number {
  const da = typeof a === 'string' ? new Date(`${a.slice(0, 10)}T00:00:00`) : new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = typeof b === 'string' ? new Date(`${b.slice(0, 10)}T00:00:00`) : new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export type ReviewUrgency = 'overdue' | 'due_soon' | 'upcoming' | 'none';

export function reviewUrgency(nextReview: string | null | undefined, today: Date = new Date(), soonDays = 30): ReviewUrgency {
  if (!nextReview) return 'none';
  const d = dayDiff(today, nextReview);
  if (d < 0) return 'overdue';
  if (d <= soonDays) return 'due_soon';
  return 'upcoming';
}

export interface DocumentLike {
  id: string;
  document_type: EstateDocumentType;
  title: string;
  review_status: EstateReviewStatus;
  next_review: string | null;
  expiration_date: string | null;
}

export interface ReviewItem {
  id: string;
  documentType: EstateDocumentType;
  title: string;
  nextReview: string;
  urgency: ReviewUrgency;
  daysUntil: number;
}

export function upcomingReviews(docs: readonly DocumentLike[], today: Date = new Date()): ReviewItem[] {
  return docs
    .filter((d) => d.next_review)
    .map((d) => ({
      id: d.id,
      documentType: d.document_type,
      title: d.title,
      nextReview: d.next_review as string,
      urgency: reviewUrgency(d.next_review, today),
      daysUntil: dayDiff(today, d.next_review as string),
    }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

export const ESSENTIAL_DOCUMENTS: EstateDocumentType[] = ['will', 'power_of_attorney', 'advance_directive'];

export function documentGaps(docs: readonly DocumentLike[]): EstateDocumentType[] {
  const have = new Set(docs.map((d) => d.document_type));
  return ESSENTIAL_DOCUMENTS.filter((t) => !have.has(t));
}

export function expiredDocuments(docs: readonly DocumentLike[], today: Date = new Date()): DocumentLike[] {
  return docs.filter((d) => {
    if (d.review_status === 'expired') return true;
    if (d.expiration_date && dayDiff(today, d.expiration_date) < 0) return true;
    return false;
  });
}

export interface EstateSummary {
  count: number;
  overdue: number;
  dueSoon: number;
  expired: number;
  gaps: EstateDocumentType[];
  text: string;
}

export function estateSummary(docs: readonly DocumentLike[], today: Date = new Date()): EstateSummary {
  const reviews = upcomingReviews(docs, today);
  const overdue = reviews.filter((r) => r.urgency === 'overdue').length;
  const dueSoon = reviews.filter((r) => r.urgency === 'due_soon').length;
  const expired = expiredDocuments(docs, today).length;
  const gaps = documentGaps(docs);
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (dueSoon > 0) parts.push(`${dueSoon} review soon`);
  if (expired > 0) parts.push(`${expired} expired`);
  if (gaps.length > 0) parts.push(`${gaps.length} essential gap${gaps.length === 1 ? '' : 's'}`);
  const text = docs.length === 0
    ? 'No estate documents yet'
    : parts.length
      ? parts.join(' · ')
      : 'All documents current';
  return { count: docs.length, overdue, dueSoon, expired, gaps, text };
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
