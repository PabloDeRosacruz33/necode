import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Environment-backed dictation: a client sends a short recording and the
 * environment transcribes it with its own speech-to-text provider (Groq
 * Whisper), so the provider key never leaves the host.
 */
export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 12 * 1024 * 1024;

export const VoiceTranscribeInput = Schema.Struct({
  /** Base64 of the recorded file, as captured (m4a, wav, webm…). */
  audioBase64: Schema.String.check(
    Schema.isMaxLength(Math.ceil((VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES * 4) / 3) + 4),
  ),
  mimeType: TrimmedNonEmptyString,
  /** ISO-639-1 hint such as "es". Omit to let the model detect the language. */
  language: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export class VoiceTranscribeError extends Schema.TaggedError<VoiceTranscribeError>()(
  "VoiceTranscribeError",
  {
    reason: Schema.Literals(["not-configured", "failed"]),
    message: Schema.String,
  },
) {}
