export const TRANSCRIPTION_CANCELLED = 'Local processing was cancelled. Your saved audio is unchanged.';

// Older cancelled runs already persisted this exact error, before the durable flag existed.
export function automaticTranscriptionEligible(meeting) {
  return !!meeting?.id && !!meeting.tracks?.length && ['saved','interrupted','ready'].includes(meeting.status)
    && !meeting.transcripts?.length && meeting.autoTranscribeSuppressed !== true && meeting.error !== TRANSCRIPTION_CANCELLED;
}
