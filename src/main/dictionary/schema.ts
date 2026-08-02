import { z } from 'zod';

export const DICTIONARY_TEXT_MAX = 256;
export const DICTIONARY_CONTEXT_MAX = 1_000;
export const DICTIONARY_VARIANTS_MAX = 100;
export const DICTIONARY_ENTRIES_MAX = 5_000;

export const UserDictionaryEntrySchema = z.object({
  correct: z.string().min(1).max(DICTIONARY_TEXT_MAX),
  variants: z
    .array(z.string().min(1).max(DICTIONARY_TEXT_MAX))
    .max(DICTIONARY_VARIANTS_MAX)
    .default([]),
  context: z.string().max(DICTIONARY_CONTEXT_MAX).optional()
});

export const UserDictionarySchema = z.object({
  $comment: z.string().optional(),
  version: z.literal(1),
  entries: z.array(UserDictionaryEntrySchema).max(DICTIONARY_ENTRIES_MAX)
});

export type UserDictionaryEntry = z.infer<typeof UserDictionaryEntrySchema>;
export type UserDictionary = z.infer<typeof UserDictionarySchema>;

export interface DictionaryCorrection {
  variant: string;
  correct: string;
}
