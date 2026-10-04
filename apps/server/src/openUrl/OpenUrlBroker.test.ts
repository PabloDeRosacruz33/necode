import { assert, it } from "@effect/vitest";
import type { OpenUrlRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OpenUrlBroker from "./OpenUrlBroker.ts";

/**
 * A connected device: records every page it is sent and confirms it unless it is `silent`
 * (a phone in the background).
 */
const device = (
  broker: OpenUrlBroker.OpenUrlBroker["Service"],
  input: { connectionId: string; memberId: string | null; desktop: boolean; silent?: boolean },
) =>
  Effect.gen(function* () {
    const received: Array<string> = [];
    yield* broker.connect(input).pipe(
      Stream.runForEach((request: OpenUrlRequest) =>
        Effect.sync(() => received.push(request.url)).pipe(
          Effect.andThen(input.silent ? Effect.void : broker.ack(request.requestId)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return received;
  });

it.effect("sends a page to the device viewing the thread, then to its author's desktop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* OpenUrlBroker.make;
      const pabloMac = yield* device(broker, {
        connectionId: "a",
        memberId: "pablo",
        desktop: true,
      });
      const pabloPhone = yield* device(broker, {
        connectionId: "b",
        memberId: "pablo",
        desktop: false,
      });
      const roiMac = yield* device(broker, { connectionId: "c", memberId: "roi", desktop: true });

      yield* broker.noteViewing("b", "thread-1");
      assert.isTrue(
        yield* broker.open({
          url: "https://a.test",
          threadId: "thread-1",
          authorMemberId: "pablo",
        }),
      );
      assert.isTrue(
        yield* broker.open({
          url: "https://b.test",
          threadId: "thread-2",
          authorMemberId: "pablo",
        }),
      );

      assert.deepStrictEqual(pabloPhone, ["https://a.test"]);
      assert.deepStrictEqual(pabloMac, ["https://b.test"]);
      assert.deepStrictEqual(roiMac, []);
    }),
  ),
);

it.effect("tries the next device when one does not confirm, and never another person's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* OpenUrlBroker.make;
      const roiMac = yield* device(broker, {
        connectionId: "a",
        memberId: "roi",
        desktop: true,
        silent: true,
      });
      const roiPhone = yield* device(broker, {
        connectionId: "b",
        memberId: "roi",
        desktop: false,
      });
      const pabloMac = yield* device(broker, {
        connectionId: "c",
        memberId: "pablo",
        desktop: true,
      });

      const opened = yield* broker
        .open({ url: "https://login.test", threadId: "thread-1", authorMemberId: "roi" })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(yield* Fiber.join(opened));
      assert.deepStrictEqual(roiMac, ["https://login.test"]);
      assert.deepStrictEqual(roiPhone, ["https://login.test"]);
      assert.deepStrictEqual(pabloMac, []);

      assert.isFalse(
        yield* broker.open({
          url: "https://x.test",
          threadId: "thread-2",
          authorMemberId: "nobody",
        }),
      );
    }),
  ),
);
