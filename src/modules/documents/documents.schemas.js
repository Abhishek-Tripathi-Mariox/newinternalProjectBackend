import { z } from 'zod';
import { DOC_KINDS } from './documents.service.js';

export const docParams = z.object({ id: z.uuid('Invalid document id') });
export const kindSchema = z.object({ kind: z.enum(DOC_KINDS) });
