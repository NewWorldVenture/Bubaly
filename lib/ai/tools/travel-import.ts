import { z } from 'zod';
import { defineTool } from './types';
import { ok } from '@/lib/services/types';
import { previewConfirmationImport } from '@/lib/services/trips/confirmation-import';
import {
  confirmationResultSchema, type ConfirmationSource, type ConfirmationFields,
} from '@/lib/vacations/confirmation-import';

// Providers need structural schemas without domain refinements. The service's
// previewConfirmationImport still performs the complete strict domain parse.
const confirmationSourceInputSchema = z.object({
  title: z.string().min(1).max(160),
  text: z.string().min(1).max(65536),
}).strict() satisfies z.ZodType<ConfirmationSource>;

const confirmationFieldsInputSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  location: z.string().min(1).max(500).nullable(),
  reservedAt: z.string(),
  partySize: z.number().int().min(1).max(1000).nullable(),
  confirmationCode: z.string().min(1).max(120).nullable(),
  booked: z.boolean(),
}).strict() satisfies z.ZodType<ConfirmationFields>;

export const travelImportTools = [
  defineTool({
    name: 'travel.import',
    description: 'Prepare an unsaved preview of a user-supplied travel confirmation. Requires complete user-reviewed fields, including an explicit booked value. A parent or adult must manually review and save in the trip UI. Does not save, book, contact a provider, or verify bookings, availability, or prices.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      vacationId: z.string().uuid(),
      source: confirmationSourceInputSchema,
      fields: confirmationFieldsInputSchema,
    }).strict(),
    output: z.object({
      result: confirmationResultSchema,
      reviewUrl: z.string(),
    }).strict(),
    summarize: (_input, output) =>
      'Prepared an unsaved confirmation preview. [Review and save manually](' + output.reviewUrl
      + '). No booking, availability, or price verification was performed.',
    execute: async (scope, input) => {
      const result = await previewConfirmationImport(scope, input);
      if (!result.ok) return result;
      return ok({
        result: result.data,
        reviewUrl: '/dashboard/vacations/' + input.vacationId + '/ai-assistant',
      });
    },
  }),
];
