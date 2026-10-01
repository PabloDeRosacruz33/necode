import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VoiceTranscribeError,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** Secret store entry holding the Groq API key (`<secretsDir>/groq-api-key.bin`). */
export const GROQ_API_KEY_SECRET = "groq-api-key";
const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
/**
 * The team dictates in Spanish. Left to detect the language itself, Whisper misreads short
 * voice notes as English and returns nonsense, so Spanish is the default unless a client
 * names another language.
 */
const DEFAULT_TRANSCRIPTION_LANGUAGE = "es";
/** Whisper spells names it has seen in the prompt; this keeps product and team names intact. */
const TRANSCRIPTION_PROMPT =
  "Nota de voz en español para Necode. Necora, Roi, Pablo, staging, merge, commit, rama, push, pull request, Vercel, Supabase.";

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
};

export interface VoiceTranscriptionShape {
  readonly transcribe: (
    input: VoiceTranscribeInput,
  ) => Effect.Effect<VoiceTranscribeResult, VoiceTranscribeError>;
}

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  VoiceTranscriptionShape
>()("t3/voice/VoiceTranscription") {}

const failed = (message: string) => new VoiceTranscribeError({ reason: "failed", message });

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  // Read on every call so adding or rotating the key needs no restart.
  const readApiKey = secrets.get(GROQ_API_KEY_SECRET).pipe(
    Effect.map((stored) =>
      Option.getOrUndefined(Option.map(stored, (bytes) => new TextDecoder().decode(bytes).trim())),
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.map((stored) => stored || process.env.GROQ_API_KEY?.trim() || undefined),
  );

  const transcribe: VoiceTranscriptionShape["transcribe"] = (input) =>
    Effect.gen(function* () {
      const apiKey = yield* readApiKey;
      if (!apiKey) {
        return yield* new VoiceTranscribeError({
          reason: "not-configured",
          message: "This environment has no speech-to-text key configured.",
        });
      }
      const audio = Buffer.from(input.audioBase64, "base64");
      if (audio.byteLength === 0) return yield* failed("The recording is empty.");
      if (audio.byteLength > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
        return yield* failed("The recording is too long to transcribe.");
      }
      const mimeType = input.mimeType.toLowerCase();
      const form = new FormData();
      form.append(
        "file",
        new Blob([audio], { type: mimeType }),
        `recording.${EXTENSION_BY_MIME[mimeType] ?? "m4a"}`,
      );
      form.append("model", GROQ_TRANSCRIPTION_MODEL);
      form.append("response_format", "json");
      form.append("temperature", "0");
      const language = input.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE;
      form.append("language", language);
      if (language === DEFAULT_TRANSCRIPTION_LANGUAGE) form.append("prompt", TRANSCRIPTION_PROMPT);

      const response = yield* HttpClientRequest.post(GROQ_TRANSCRIPTIONS_URL).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.bodyFormData(form),
        httpClient.execute,
        Effect.mapError(() => failed("Could not reach the speech-to-text service.")),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* failed(`Speech-to-text failed (HTTP ${response.status}).`);
      }
      const body = (yield* response.json.pipe(
        Effect.mapError(() => failed("Speech-to-text returned an unreadable response.")),
      )) as { readonly text?: unknown };
      return { text: typeof body.text === "string" ? body.text.trim() : "" };
    }).pipe(Effect.withSpan("VoiceTranscription.transcribe"));

  return VoiceTranscription.of({ transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
