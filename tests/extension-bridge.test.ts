import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { CommandPage } from "../src/content-command.ts";
import { ExtensionBridge, extensionBridgeLayer } from "../src/extension-bridge.ts";
import { ApiError, NetworkError, StorageError, failureReply } from "../src/user-errors.ts";

class PageFake {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly messages: unknown[] = [];
  readonly warnings: unknown[] = [];
  throws = false;
  synchronous = false;
  private nextId = 0;
  readonly page: CommandPage = {
    location: { origin: "https://www.komoot.com" },
    addEventListener: (_type, listener) => void this.listeners.add(listener),
    removeEventListener: (_type, listener) => void this.listeners.delete(listener),
    postMessage: (input, origin) => {
      expect(origin).toBe(this.page.location.origin);

      if (this.throws) throw new Error("private postMessage error");
      this.messages.push(input);

      if (this.synchronous) this.fetchReply("request-1", { success: true, data: 7 });
    },
  };
  readonly layer = extensionBridgeLayer(
    this.page,
    { debug: () => {}, warn: (_message, fields) => void this.warnings.push(fields) },
    () => `request-${++this.nextId}`,
  );

  readonly bridge = {
    fetchResource: (url: string, responseType: "json" | "text" = "json") =>
      Effect.gen(function* () {
        const bridge = yield* ExtensionBridge;

        return yield* bridge.fetchResource(url, responseType);
      }).pipe(Effect.provide(this.layer)),
    getStorage: <Keys>(keys: Keys) =>
      Effect.gen(function* () {
        const bridge = yield* ExtensionBridge;

        return yield* bridge.getStorage(keys);
      }).pipe(Effect.provide(this.layer)),
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

  fetchReply<Response>(requestId: string, response: Response) {
    this.emit({ type: "ZALICZGMINE_FETCH_RESPONSE", requestId, response, error: undefined });
  }
}

test("bridge preserves payloads, filters untrusted events, and correlates concurrent replies", async () => {
  const fake = new PageFake();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fetch = yield* fake.bridge
        .fetchResource("https://example.test", "text")
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      const storage = yield* fake.bridge.getStorage(["language"]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(fake.messages).toEqual([
        {
          type: "ZALICZGMINE_FETCH_REQUEST",
          requestId: "request-1",
          url: "https://example.test",
          responseType: "text",
        },
        { type: "ZALICZGMINE_STORAGE_GET", requestId: "request-2", keys: ["language"] },
      ]);

      const reply = {
        type: "ZALICZGMINE_FETCH_RESPONSE",
        requestId: "request-1",
        response: { success: true, data: "text" },
      };

      fake.emit(reply, false);
      fake.emit(reply, true, false);
      fake.emit({ ...reply, requestId: "other" });
      fake.emit({ ...reply, type: "other" });

      for (const input of [null, undefined, 42, {}, { ...reply, error: 42 }]) fake.emit(input);
      expect(fetch.pollUnsafe()).toBeUndefined();
      fake.emit({
        type: "ZALICZGMINE_STORAGE_RESPONSE",
        requestId: "request-2",
        data: { language: "pl", resolvedLanguage: "pl" },
        error: undefined,
      });
      expect(yield* Fiber.join(storage)).toEqual({ language: "pl", resolvedLanguage: "pl" });
      expect(fake.listeners.size).toBe(1);
      fake.emit(reply);
      expect(yield* Fiber.join(fetch)).toBe("text");
      expect(fake.listeners.size).toBe(0);
    }),
  );
});

test("bridge captures synchronous replies without leaving listeners behind", async () => {
  const fake = new PageFake();
  fake.synchronous = true;
  expect(await Effect.runPromise(fake.bridge.fetchResource("x"))).toBe(7);
  expect(fake.listeners.size).toBe(0);
});

test("bridge decodes remote failures and keeps unknown remote failures as defects", async () => {
  for (const response of [
    failureReply(new ApiError({ reason: "userNotFound" })),
    { success: false, error: "private" },
    { success: "true" },
  ]) {
    const fake = new PageFake();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* fake.bridge.fetchResource("x").pipe(Effect.exit, Effect.forkChild);
        yield* Effect.yieldNow;
        fake.fetchReply("request-1", response);
        const exit = yield* Fiber.join(fiber);

        if ("failure" in response) {
          expect(Exit.hasFails(exit)).toBe(true);
        } else expect(Exit.hasDies(exit)).toBe(true);
        expect(fake.listeners.size).toBe(0);
      }),
    );
  }
});

test("bridge maps transport errors and preserves empty storage fallback", async () => {
  for (const storage of [false, true]) {
    const fake = new PageFake();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* (
          storage ? fake.bridge.getStorage(null) : fake.bridge.fetchResource("x")
        ).pipe(Effect.flip, Effect.forkChild);

        yield* Effect.yieldNow;
        fake.emit({
          type: storage ? "ZALICZGMINE_STORAGE_RESPONSE" : "ZALICZGMINE_FETCH_RESPONSE",
          requestId: "request-1",
          error: "private error",
        });
        expect(yield* Fiber.join(fiber)).toEqual(
          storage
            ? new StorageError({ operation: "read" })
            : new NetworkError({ reason: "unavailable" }),
        );
        expect(fake.listeners.size).toBe(0);
        const empty = yield* fake.bridge.getStorage(null).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        fake.emit({
          type: "ZALICZGMINE_STORAGE_RESPONSE",
          requestId: "request-2",
          data: undefined,
        });
        expect(yield* Fiber.join(empty)).toEqual({});
      }),
    );
  }
});

test("bridge keeps five/thirty-second deadlines and cleans up late replies", async () => {
  for (const storage of [false, true]) {
    const fake = new PageFake();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* (
          storage ? fake.bridge.getStorage(null) : fake.bridge.fetchResource("x")
        ).pipe(Effect.flip, Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(storage ? "5 seconds" : "30 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(
          storage
            ? new StorageError({ operation: "read" })
            : new NetworkError({ reason: "timeout" }),
        );
        expect(fake.listeners.size).toBe(0);
        expect(fake.warnings).toHaveLength(1);
        fake.fetchReply("request-1", { success: true, data: "late" });
        expect(fake.listeners.size).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  }
});

test("interruption and postMessage defects release bridge listeners", async () => {
  const fake = new PageFake();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* fake.bridge.fetchResource("x").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(fake.listeners.size).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(fake.listeners.size).toBe(0);
      fake.throws = true;
      expect(Exit.hasDies(yield* Effect.exit(fake.bridge.fetchResource("x")))).toBe(true);
      expect(fake.listeners.size).toBe(0);
      expect(fake.warnings).toEqual([]);
    }),
  );
});
