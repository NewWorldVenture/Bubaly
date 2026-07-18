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
  const { data, error } = await supabase
    .from('marketing_forms')
    .select('*')
    .eq('id', id)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  // A transient read failure must not 404 a live form (a permanent-gone signal).
  // Throw so it renders a retryable 5xx; reserve notFound() for a truly missing id.
  if (error) throw new Error(`Failed to load marketing form "${id}": ${error.message}`);
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
  if (fields.length === 0) {
    return (
      <Section className="pt-20">
        <SectionHeading
          eyebrow="Form unavailable"
          title={metaString(meta(form), 'title') ?? form.name}
          description="This form is temporarily unavailable because it has no usable fields. Please try again later or contact us directly."
        />
      </Section>
    );
  }

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
