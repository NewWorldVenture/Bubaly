'use client';

import { useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { validateSubmission, fieldAutoComplete, inputType, type FormField } from '@/lib/marketing/forms';
import { describeDbError } from '@/lib/supabase/errors';

/**
 * Public form renderer. Validates locally (mirroring the server) for instant
 * feedback, then POSTs to /api/forms/submit which records the submission via the
 * service role and fires any `form_submitted` automation. Shows a success state
 * on completion.
 */
export function PublicForm({ formId, fields, submitLabel, successMessage }: {
  formId: string;
  fields: FormField[];
  submitLabel?: string;
  successMessage?: string;
}) {
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const fd = new FormData(e.currentTarget);
    const values: Record<string, string> = {};
    for (const f of fields) values[f.key] = String(fd.get(f.key) ?? '');

    const local = validateSubmission(fields, values);
    if (!local.ok) { setErrors(local.errors); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/forms/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ formId, values: local.cleaned }),
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
        <h3 className="mt-4 text-lg font-semibold">Thank you!</h3>
        <p className="mt-1 text-sm text-muted">{successMessage ?? 'Your submission has been received.'}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="glass-card space-y-5 p-7" noValidate>
      {fields.map((f) => (
        <Field key={f.key} label={f.label} error={errors[f.key]} required={f.required}>
          {(id) => f.type === 'textarea'
            ? <Textarea id={id} name={f.key} />
            : <Input id={id} name={f.key} type={inputType(f.type)} autoComplete={fieldAutoComplete(f.type)} />}
        </Field>
      ))}
      <Button type="submit" loading={loading} className="w-full">
        {!loading && <Send className="h-4 w-4" />} {submitLabel ?? 'Submit'}
      </Button>
    </form>
  );
}
