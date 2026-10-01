import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly fields: Record<string, string>;
  readonly fileName: string | null;
}

const makeLayer = (
  captured: Array<CapturedRequest>,
  reply = { status: 200, text: " hola mundo " },
) =>
  VoiceTranscription.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "necode-voice-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
          Effect.sync(() => {
            const form = request.body._tag === "FormData" ? request.body.formData : null;
            const fields: Record<string, string> = {};
            let fileName: string | null = null;
            form?.forEach((value, key) => {
              if (typeof value === "string") fields[key] = value;
              else fileName = value.name;
            });
            captured.push({
              url: request.url,
              authorization: request.headers.authorization,
              fields,
              fileName,
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(`{"text":"${reply.text}"}`, {
                status: reply.status,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      ),
    ),
  );

const input = { audioBase64: Buffer.from("fake audio").toString("base64"), mimeType: "audio/mp4" };

it.effect("reports a missing key instead of calling the provider", () => {
  const captured: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const previous = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const error = yield* Effect.flip(voice.transcribe(input));
    if (previous !== undefined) process.env.GROQ_API_KEY = previous;
    expect(error.reason).toBe("not-configured");
    expect(captured).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(captured)));
});

it.effect("sends the recording to Groq Whisper with the stored key", () => {
  const captured: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(
      VoiceTranscription.GROQ_API_KEY_SECRET,
      new TextEncoder().encode("gsk_test_key\n"),
    );
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const result = yield* voice.transcribe({ ...input, language: "es" });

    expect(result.text).toBe("hola mundo");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(captured[0]?.authorization).toBe("Bearer gsk_test_key");
    expect(captured[0]?.fields).toMatchObject({ model: "whisper-large-v3-turbo", language: "es" });
    expect(captured[0]?.fileName).toBe("recording.m4a");
  }).pipe(Effect.provide(makeLayer(captured)));
});

it.effect("dictates in Spanish unless the client names another language", () => {
  const captured: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(VoiceTranscription.GROQ_API_KEY_SECRET, new TextEncoder().encode("gsk"));
    const voice = yield* VoiceTranscription.VoiceTranscription;
    yield* voice.transcribe(input);
    yield* voice.transcribe({ ...input, language: "en" });

    expect(captured[0]?.fields).toMatchObject({ language: "es" });
    expect(captured[0]?.fields.prompt).toContain("Necode");
    expect(captured[1]?.fields).toMatchObject({ language: "en" });
    expect(captured[1]?.fields.prompt).toBeUndefined();
  }).pipe(Effect.provide(makeLayer(captured)));
});

it.effect("surfaces provider failures", () => {
  const captured: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(VoiceTranscription.GROQ_API_KEY_SECRET, new TextEncoder().encode("gsk"));
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const error = yield* Effect.flip(voice.transcribe(input));
    expect(error.reason).toBe("failed");
    expect(error.message).toContain("401");
  }).pipe(Effect.provide(makeLayer(captured, { status: 401, text: "" })));
});
