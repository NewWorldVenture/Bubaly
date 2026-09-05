'use client';

import { useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Field } from '@/components/ui/input';
import { contactSchema, CONTACT_TOPICS, fieldErrors } from '@/lib/validation';
import { useToast } from '@/components/ui/toast';
import { describeDbError } from '@/lib/supabase/errors';

export function ContactForm() {
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const input = {
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      topic: String(form.get('topic') ?? 'general'),
      message: String(form.get('message') ?? ''),
    };
    const parsed = contactSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setErrors(data.fields);
        throw new Error(data.error ?? 'Something went wrong');
      }
      setDone(true);
    } catch (err) {
      toastError(describeDbError(err, 'Something went wrong'));
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="glass-card flex flex-col items-center p-10 text-center">
        <CheckCircle2 className="h-12 w-12 text-success" />
        <h3 className="mt-4 text-lg font-semibold">Message sent</h3>
        <p className="mt-1 text-sm text-muted">Thanks for reaching out — we’ll get back to you soon.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="glass-card space-y-5 p-7" noValidate>
      <Field label="Your name" error={errors.name} required>
        {(id) => <Input id={id} name="name" autoComplete="name" placeholder="Jordan Rivera" />}
      </Field>
      <Field label="Email" error={errors.email} required>
        {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
      </Field>
      <Field label="What’s this about?" error={errors.topic}>
        {(id) => (
          <select
            id={id}
            name="topic"
            defaultValue="general"
            className="h-11 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm text-fg focus-ring sm:text-base"
          >
            {CONTACT_TOPICS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Message" error={errors.message} required>
        {(id) => <Textarea id={id} name="message" placeholder="How can we help your family?" />}
      </Field>
      <Button type="submit" loading={loading} className="w-full">
        {!loading && <Send className="h-4 w-4" />} Send message
      </Button>
    </form>
  );
}
