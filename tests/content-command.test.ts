import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Deferred, Effect, Exit, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { forwardCommand, type CommandPage } from "../src/content-command.ts";
import { NetworkError, apiFailure } from "../src/user-errors.ts";

class PageFake {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly messages: unknown[] = [];
  throws = false;
  readonly page: CommandPage = {
    location: { origin: "https://www.komoot.com" },
    addEventListener: (_type, listener) => void this.listeners.add(listener),
    removeEventListener: (_type, listener) => void this.listeners.delete(listener),
    postMessage: (input, origin) => {
      expect(origin).toBe(this.page.location.origin);

      if (this.throws) throw new Error("private page error");
      this.messages.push(input);
    },
  };

  emit<Input>(data: Input, sameWindow = true, sameOrigin = true) {
    for (const listener of this.listeners) {
      runInNewContext("listener({ source, origin, data })", {
        listener,
        source: sameWindow ? this.page : {},
        origin: sameOrigin ? this.page.location.origin : "https://other.test",
        data,
      });
    }
  }
}

test("commands await scripts, retain payloads, filter page replies, and remove the listener after success", async () => {
  const fake = new PageFake();
  const command = { action: "importGpx", data: { id: "track-1", text: "<gpx/>" } };
  const reply = { success: true, tracks: ["track-1"], extra: { opaque: true } };

  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();

      const fiber = yield* forwardCommand(
        command,
        Deferred.await(ready),
        fake.page,
        "request-1",
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(fake.messages).toEqual([]);
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.yieldNow;
      expect(fake.messages).toEqual([
        { type: "ZALICZGMINE_COMMAND", requestId: "request-1", ...command },
      ]);
      expect(fake.listeners.size).toBe(1);

      const response = {
        type: "ZALICZGMINE_COMMAND_RESPONSE",
        requestId: "request-1",
        response: reply,
      };

      fake.emit(response, false);
      fake.emit(response, true, false);
      fake.emit({ ...response, requestId: "other" });
      fake.emit(null);
      fake.emit({ type: "other" });
      expect(fiber.pollUnsafe()).toBeUndefined();
      fake.emit(response);
      expect(yield* Fiber.join(fiber)).toEqual(reply);
      expect(fake.listeners.size).toBe(0);
    }),
  );
});

test("commands time out once and clean up response listeners using the five-second contract", async () => {
  const fake = new PageFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* forwardCommand(
        { action: "getStatus" },
        Effect.void,
        fake.page,
        "request-1",
      ).pipe(Effect.result, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(fake.listeners.size).toBe(1);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(
        Result.fail(new NetworkError({ reason: "timeout" })),
      );
      expect(fake.listeners.size).toBe(0);
      fake.emit({
        type: "ZALICZGMINE_COMMAND_RESPONSE",
        requestId: "request-1",
        response: { success: true },
      });
      expect(fake.listeners.size).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("timing out during script loading never forwards a late command", async () => {
  const fake = new PageFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();

      const fiber = yield* forwardCommand(
        { action: "getStatus" },
        Deferred.await(ready),
        fake.page,
        "request-1",
      ).pipe(Effect.result, Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);
      yield* Deferred.succeed(ready, undefined);
      expect(fake.messages).toEqual([]);
      expect(fake.listeners.size).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("command interruption, script defects, and postMessage defects release resources", async () => {
  const fake = new PageFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* forwardCommand(
        { action: "getStatus" },
        Effect.void,
        fake.page,
        "request-1",
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(fake.listeners.size).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(fake.listeners.size).toBe(0);

      expect(
        Exit.hasDies(
          yield* Effect.exit(
            forwardCommand({}, Effect.die("script failure"), fake.page, "request-2"),
          ),
        ),
      ).toBe(true);
      fake.throws = true;
      expect(
        Exit.hasDies(yield* Effect.exit(forwardCommand({}, Effect.void, fake.page, "request-3"))),
      ).toBe(true);
      expect(fake.listeners.size).toBe(0);
    }),
  );
});

test("malformed runtime commands fail safely before page I/O", async () => {
  const fake = new PageFake();

  for (const input of [null, 42, ["getStatus"]]) {
    expect(
      await Effect.runPromise(
        forwardCommand(input, Effect.void, fake.page, "request-1").pipe(Effect.flip),
      ),
    ).toEqual(apiFailure("INVALID_REQUEST"));
  }

  expect(fake.messages).toEqual([]);
  expect(fake.listeners.size).toBe(0);
});
