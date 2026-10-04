/**
 * Delivers a web page opened on this machine to one connected device: the desktop app or the
 * phone of whoever the work belongs to. Devices subscribe with `openUrl.connect`; the server
 * already knows each connection's person (from its session) and which thread it is viewing
 * (`team.setViewing`).
 *
 * Candidates, best first: devices viewing the thread, then devices of the author of the
 * thread's latest message (or every device when that author is unknown), desktop apps before
 * phones and the most recently active first. Each candidate must confirm it opened the page
 * within a few seconds (a backgrounded phone cannot), otherwise the next one is tried. When none
 * confirms, the caller opens the page on this machine.
 */
import type { OpenUrlRequest } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const ACK_TIMEOUT = "4 seconds";

interface Registration {
  readonly connectionId: string;
  readonly memberId: string | null;
  readonly desktop: boolean;
  readonly queue: Queue.Queue<OpenUrlRequest, Cause.Done>;
  activeAt: number;
}

export class OpenUrlBroker extends Context.Service<
  OpenUrlBroker,
  {
    /** One device's stream of pages to open; it ends when the device disconnects. */
    readonly connect: (input: {
      readonly connectionId: string;
      readonly memberId: string | null;
      readonly desktop: boolean;
    }) => Stream.Stream<OpenUrlRequest>;
    readonly noteViewing: (connectionId: string, threadId: string | null) => Effect.Effect<void>;
    readonly ack: (requestId: string) => Effect.Effect<void>;
    /** True once a device confirmed it opened `url`. */
    readonly open: (input: {
      readonly url: string;
      readonly threadId: string;
      readonly authorMemberId: string | null;
    }) => Effect.Effect<boolean>;
  }
>()("t3/openUrl/OpenUrlBroker") {}

export const make = Effect.sync(() => {
  const registrations = new Set<Registration>();
  const viewing = new Map<string, string | null>();
  const pending = new Map<string, Deferred.Deferred<void>>();

  const connect: OpenUrlBroker["Service"]["connect"] = (input) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<OpenUrlRequest, Cause.Done>();
          const activeAt = yield* Clock.currentTimeMillis;
          const registration: Registration = { ...input, queue, activeAt };
          registrations.add(registration);
          return registration;
        }),
        (registration) =>
          Effect.sync(() => registrations.delete(registration)).pipe(
            Effect.andThen(Queue.shutdown(registration.queue)),
          ),
      ).pipe(Effect.map((registration) => Stream.fromQueue(registration.queue))),
    );

  const noteViewing: OpenUrlBroker["Service"]["noteViewing"] = (connectionId, threadId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      viewing.set(connectionId, threadId);
      for (const registration of registrations) {
        if (registration.connectionId === connectionId) registration.activeAt = now;
      }
    });

  const ack: OpenUrlBroker["Service"]["ack"] = (requestId) =>
    Effect.suspend(() => {
      const deferred = pending.get(requestId);
      return deferred ? Deferred.succeed(deferred, undefined).pipe(Effect.asVoid) : Effect.void;
    });

  const candidates = (threadId: string, authorMemberId: string | null) => {
    const rank = (list: ReadonlyArray<Registration>) =>
      [...list].sort((a, b) => Number(b.desktop) - Number(a.desktop) || b.activeAt - a.activeAt);
    const all = [...registrations];
    const watching = rank(all.filter((r) => viewing.get(r.connectionId) === threadId));
    const owners = rank(
      authorMemberId === null ? all : all.filter((r) => r.memberId === authorMemberId),
    );
    return [...new Set([...watching, ...owners])];
  };

  const deliver = (registration: Registration, url: string) => {
    const requestId = NodeCrypto.randomUUID();
    return Effect.gen(function* () {
      if (!registrations.has(registration)) return false;
      const deferred = yield* Deferred.make<void>();
      pending.set(requestId, deferred);
      const offered = yield* Queue.offer(registration.queue, { requestId, url });
      if (!offered) return false;
      const confirmed = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(ACK_TIMEOUT));
      return Option.isSome(confirmed);
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
  };

  const open: OpenUrlBroker["Service"]["open"] = (input) =>
    Effect.gen(function* () {
      for (const registration of candidates(input.threadId, input.authorMemberId)) {
        if (yield* deliver(registration, input.url)) {
          registration.activeAt = yield* Clock.currentTimeMillis;
          return true;
        }
      }
      return false;
    });

  return OpenUrlBroker.of({ connect, noteViewing, ack, open });
});

export const layer = Layer.effect(OpenUrlBroker, make);
