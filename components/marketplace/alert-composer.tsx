'use client';

// Create a marketplace saved search / alert. A compact inline form (not a modal)
// so the Alerts page reads as one flow. Wired to createSavedSearchAction.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BellPlus } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Input, Select, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { KIND_LABELS, KIND_ORDER, CATEGORY_LABELS, type ListingKind, type ListingCategory } from '@/lib/marketplace/listings';
import { createSavedSearchAction } from '@/app/(app)/marketplace/alerts/actions';

export function AlertComposer() {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await createSavedSearchAction({ query, kind, category, maxPrice });
      if (!res.ok) { toastError(res.error); return; }
      setQuery(''); setKind(''); setCategory(''); setMaxPrice('');
      success('Alert saved — we’ll match new listings for you');
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Keyword">{(id) => <Input id={id} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="balance bike" />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any type</option>
            {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k as ListingKind]}</option>)}
          </Select>
        )}</Field>
        <Field label="Category">{(id) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Any category</option>
            {(Object.keys(CATEGORY_LABELS) as ListingCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </Select>
        )}</Field>
        <Field label="Max price ($)">{(id) => <Input id={id} type="number" min="0" step="1" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="any" />}</Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="submit" disabled={pending} loading={pending}><BellPlus className="h-4 w-4" /> Create alert</Button>
      </div>
    </form>
  );
}
