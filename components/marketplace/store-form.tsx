'use client';

// My Store editor — create or update the member's one storefront.

import { useState, useTransition } from 'react';
import { Building2 } from 'lucide-react';
import { upsertStoreAction } from '@/app/(app)/dashboard/marketplace/actions';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Field } from '@/components/ui/input';

type StoreSeed = { name: string; tagline: string; description: string; emoji: string };

export function StoreForm({ initial }: { initial: StoreSeed | null }) {
  const [form, setForm] = useState<StoreSeed>(initial ?? { name: '', tagline: '', description: '', emoji: '' });
  const [pending, startTransition] = useTransition();
  const { success, error: toastError } = useToast();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await upsertStoreAction(form);
      if (res.ok) success(initial ? 'Store updated' : 'Your store is live 🎉');
      else toastError(res.error);
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border bg-surface/60 p-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-brand" />
        <h2 className="text-sm font-semibold">{initial ? 'Your store' : 'Open your store'}</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Store name" required>
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Baby Gear Co." required />}
        </Field>
        <Field label="Emoji">
          {(id) => <Input id={id} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="🧸" maxLength={4} />}
        </Field>
      </div>
      <Field label="Tagline">
        {(id) => <Input id={id} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="Quality hand-me-downs, priced to move" />}
      </Field>
      <Field label="About">
        {(id) => <Textarea id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} placeholder="What do you list?" />}
      </Field>
      <Button type="submit" disabled={pending || !form.name.trim()}>
        {initial ? 'Save changes' : 'Create store'}
      </Button>
    </form>
  );
}
