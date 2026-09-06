import { z } from 'zod';
import { defineTool } from './types';
import { ok } from '@/lib/services/types';
import { previewConfirmationImport } from '@/lib/services/trips/confirmation-import';
import {
  confirmationSourceSchema, confirmationFieldsSchema, confirmationResultSchema,
} from '@/lib/vacations/confirmation-import';

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
      source: confirmationSourceSchema,
      fields: confirmationFieldsSchema,
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
