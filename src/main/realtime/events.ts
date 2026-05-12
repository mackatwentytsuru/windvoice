// OpenAI Realtime API event shapes (transcription intent only).
// Schemas kept loose because the API is still in beta and may add fields.

import { z } from 'zod';

export const TranscriptionDeltaEvent = z.object({
  type: z.literal('conversation.item.input_audio_transcription.delta'),
  delta: z.string(),
  item_id: z.string().optional()
});
export type TranscriptionDeltaEvent = z.infer<typeof TranscriptionDeltaEvent>;

// Server may emit either `.completed` or `.done` for the same logical
// event depending on API version (the GA Realtime API moved to `.done`
// in 2026/05). Accept both — otherwise `.done` payloads fail Zod parse
// and the entire transcript is silently dropped (issue #5).
export const TranscriptionCompletedEvent = z.object({
  type: z.enum([
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.input_audio_transcription.done'
  ]),
  transcript: z.string(),
  item_id: z.string().optional()
});
export type TranscriptionCompletedEvent = z.infer<typeof TranscriptionCompletedEvent>;

export const ErrorEvent = z.object({
  type: z.literal('error'),
  error: z.object({
    type: z.string().optional(),
    code: z.string().optional(),
    message: z.string()
  })
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

export const InputAudioCommittedEvent = z.object({
  type: z.literal('input_audio_buffer.committed'),
  item_id: z.string().optional()
});

export const SessionUpdatedEvent = z.object({
  type: z.literal('transcription_session.updated')
});
