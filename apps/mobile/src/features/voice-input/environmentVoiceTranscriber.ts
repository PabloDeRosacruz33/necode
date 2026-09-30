import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { type EnvironmentId, VoiceTranscribeError, WS_METHODS } from "@t3tools/contracts";
import { File } from "expo-file-system";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

const transcribeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:transcribe",
  tag: WS_METHODS.voiceTranscribe,
});

const isVoiceTranscribeError = Schema.is(VoiceTranscribeError);

/**
 * Transcribes on the environment (Groq Whisper on the host) and falls back to
 * the on-device transcriber when the host has no speech-to-text key. The
 * language is detected from the audio, so Spanish works on an English phone.
 */
export function createEnvironmentVoiceTranscriber(
  environmentId: EnvironmentId,
  fallback: VoiceTranscriber | null,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      // Prepared up front: a recording binds its transcriber before it starts.
      const local: PreparedVoiceTranscription | null = fallback
        ? await fallback.prepare({ signal }).catch(() => null)
        : null;
      return {
        locale: "auto",
        transcribe: async (uri, options) => {
          const audioBase64 = await new File(uri).base64();
          throwIfVoiceTranscriptionAborted(options.signal);
          const result = await runAtomCommand(
            appAtomRegistry,
            transcribeCommand,
            { environmentId, input: { audioBase64, mimeType: "audio/mp4" } },
            { reportFailure: false, reportDefect: false },
          );
          throwIfVoiceTranscriptionAborted(options.signal);
          if (result._tag === "Success") return result.value.text;

          const cause = squashAtomCommandFailure(result);
          if (isVoiceTranscribeError(cause) && cause.reason === "not-configured" && local) {
            return local.transcribe(uri, options);
          }
          throw new VoiceTranscriptionError(
            "transcription-failed",
            cause instanceof Error ? cause.message : "Could not transcribe the recording.",
            { cause },
          );
        },
      };
    },
  };
}
