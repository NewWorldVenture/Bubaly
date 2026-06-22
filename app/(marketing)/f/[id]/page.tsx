import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase/server';
import { parseFormFields } from '@/lib/marketing/forms';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { PublicForm } from './form-renderer';

export const dynamic = 'force-dynamic';

// Marketing forms have no client RLS policies, so we read them with the
// service-role client. Only active, non-deleted forms are publicly servable.
async function getForm(id: string) {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('marketing_forms')
    .select('*')
    .eq('id', id)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  return data;
}

function meta(form: { metadata: unknown }) {
  return (form.metadata ?? {}) as Record<string, unknown>;
}
function metaString(m: Record<string, unknown>, key: string): string | undefined {
  const v = m[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const form = await getForm(id);
  // Forms are utility pages — keep them out of the search index.
  if (!form) return { title: 'Not found', robots: { index: false } };
  return { title: metaString(meta(form), 'title') ?? form.name, robots: { index: false } };
}

export default async function PublicFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await getForm(id);
  if (!form) notFound();

  const fields = parseFormFields(form.fields);
  if (fields.length === 0) notFound();

  const m = meta(form);
  return (
    <Section className="pt-20">
      <SectionHeading
        eyebrow="Form"
        title={metaString(m, 'title') ?? form.name}
        description={metaString(m, 'description')}
      />
      <div className="mx-auto mt-12 max-w-xl">
        <PublicForm
          formId={form.id}
          fields={fields}
          submitLabel={metaString(m, 'submit_label')}
          successMessage={metaString(m, 'success_message')}
        />
      </div>
    </Section>
  );
}
