import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { backgroundLifetime } from "../src/background-listener.ts";
import { ChromeRuntime, chromeRuntimeLayer, type ChromeRuntimeApi } from "../src/chrome-runtime.ts";
import { fetchRuntimeJson } from "../src/runtime-fetch.ts";
import { ApiError, NetworkError, apiFailure, failureReply } from "../src/user-errors.ts";

class RuntimeFake {
  readonly requests: Array<Parameters<ChromeRuntimeApi["sendMessage"]>[0]> = [];
  readonly listeners = new Set<Parameters<ChromeRuntimeApi["onMessage"]["addListener"]>[0]>();
  readonly pending: Array<() => void> = [];
  reply: unknown;

  constructor() {
    this.reply = { success: true, data: { opaque: [1, 2] } };
  }
  fail = false;
  throws = false;
  hold = false;
  errorReads = 0;
  private error: chrome.runtime.LastError | undefined;

  get api(): ChromeRuntimeApi {
    const readError = () => {
      this.errorReads++;

      return this.error;
    };

    return {
      get lastError() {
        return readError();
      },
      sendMessage: (request, callback) => {
        this.requests.push(request);

        if (this.throws) throw new Error("private invocation error");

        const complete = () => {
          this.error = this.fail ? { message: "private runtime error" } : undefined;

          try {
            callback(this.reply);
          } finally {
            this.error = undefined;
          }
        };

        if (this.hold) this.pending.push(complete);
        else complete();
      },
      onMessage: {
        addListener: (listener) => void this.listeners.add(listener),
        removeListener: (listener) => void this.listeners.delete(listener),
      },
    };
  }

  get layer() {
    return chromeRuntimeLayer(this.api);
  }
}

test("runtime sends the existing fetch payload and leaves reply data opaque", async () => {
  const fake = new RuntimeFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* ChromeRuntime;
      expect(
        yield* runtime.sendFetch({ type: "ZALICZGMINE_FETCH", url: "https://example.test" }),
      ).toEqual(fake.reply);
      expect(yield* fetchRuntimeJson("https://example.test/json")).toEqual({ opaque: [1, 2] });
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(fake.requests).toEqual([
    { type: "ZALICZGMINE_FETCH", url: "https://example.test" },
    { type: "ZALICZGMINE_FETCH", url: "https://example.test/json", responseType: "json" },
  ]);
  expect(fake.errorReads).toBe(2);
});

test("runtime rejects malformed requests before Chrome I/O", async () => {
  const fake = new RuntimeFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* ChromeRuntime;

      for (const input of [
        null,
        {},
        { type: "other", url: "x" },
        { type: "ZALICZGMINE_FETCH", url: 42 },
        { type: "ZALICZGMINE_FETCH", url: "x", responseType: "xml" },
      ]) {
        expect(yield* Effect.flip(runtime.sendFetch(input))).toEqual(apiFailure("INVALID_REQUEST"));
      }
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(fake.requests).toEqual([]);
});

test("lastError and synchronous invocation errors use the existing safe NetworkError", async () => {
  for (const throws of [false, true]) {
    const fake = new RuntimeFake();
    fake.fail = true;
    fake.throws = throws;

    const error = await Effect.runPromise(
      fetchRuntimeJson("https://example.test").pipe(Effect.flip, Effect.provide(fake.layer)),
    );

    expect(error).toEqual(new NetworkError({ reason: "unavailable" }));
    expect(failureReply(error).error).toBe("api.fetchError");
    expect(JSON.stringify(failureReply(error))).not.toContain("private");
    expect(fake.errorReads).toBe(throws ? 0 : 1);
  }
});

test("runtime JSON decodes remote expected failures and treats unknown/malformed replies as defects", async () => {
  const fake = new RuntimeFake();
  fake.reply = failureReply(apiFailure("USER_NOT_FOUND"));
  expect(
    await Effect.runPromise(fetchRuntimeJson("x").pipe(Effect.flip, Effect.provide(fake.layer))),
  ).toEqual(new ApiError({ reason: "userNotFound" }));

  for (const reply of [
    undefined,
    null,
    42,
    { success: "true", data: [] },
    { success: false, error: "private" },
  ]) {
    fake.reply = reply;

    const exit = await Effect.runPromise(
      fetchRuntimeJson("x").pipe(Effect.exit, Effect.provide(fake.layer)),
    );

    expect(Exit.hasDies(exit)).toBe(true);
  }
});

test("interruption ignores late runtime replies but still consumes callback lastError", async () => {
  const fake = new RuntimeFake();
  fake.hold = true;
  fake.fail = true;
  let continued = false;

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* fetchRuntimeJson("x").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            continued = true;
          }),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      expect(fake.pending).toHaveLength(1);
      yield* Fiber.interrupt(fiber);

      for (const complete of fake.pending) complete();
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(continued).toBe(false);
  expect(fake.errorReads).toBe(1);
});

test("runtime listeners preserve synchronous channel decisions and clean up on success/failure", async () => {
  for (const fail of [false, true]) {
    const fake = new RuntimeFake();
    const replies: unknown[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ChromeRuntime;
        yield* runtime.listen((_input, respond) => {
          respond({ success: true });

          return true;
        });
        expect(fake.listeners.size).toBe(1);

        for (const listener of fake.listeners)
          expect(listener({}, {}, <Reply>(reply: Reply) => replies.push(reply))).toBe(true);

        if (fail) return yield* new NetworkError({ reason: "unavailable" });
      }).pipe(Effect.scoped, Effect.result, Effect.provide(fake.layer)),
    );
    expect(replies).toEqual([{ success: true }]);
    expect(fake.listeners.size).toBe(0);
  }
});

test("closing the background scope removes its listener and aborts in-flight fetches without responding", async () => {
  const fake = new RuntimeFake();
  let signal: AbortSignal | undefined;
  const replies: unknown[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* backgroundLifetime((_url, requestSignal) => {
        signal = requestSignal;

        return new Promise<Response>(() => {});
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(fake.listeners.size).toBe(1);

      for (const listener of fake.listeners) {
        expect(
          listener({ type: "ZALICZGMINE_FETCH", url: "x" }, {}, <Reply>(reply: Reply) =>
            replies.push(reply),
          ),
        ).toBe(true);
      }

      yield* Effect.yieldNow;
      expect(signal?.aborted).toBe(false);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
      expect(fake.listeners.size).toBe(0);
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(replies).toEqual([]);
});

test("background requests keep the thirty-second timeout and respond exactly once", async () => {
  const fake = new RuntimeFake();
  const replies: unknown[] = [];
  let signal: AbortSignal | undefined;

  await Effect.runPromise(
    Effect.gen(function* () {
      const worker = yield* backgroundLifetime((_url, requestSignal) => {
        signal = requestSignal;

        return new Promise<Response>(() => {});
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;

      for (const listener of fake.listeners) {
        expect(
          listener({ type: "ZALICZGMINE_FETCH", url: "x" }, {}, <Reply>(reply: Reply) =>
            replies.push(reply),
          ),
        ).toBe(true);
      }

      yield* TestClock.adjust("30 seconds");
      expect(replies).toEqual([failureReply(new NetworkError({ reason: "timeout" }))]);
      expect(signal?.aborted).toBe(true);
      yield* Fiber.interrupt(worker);
      expect(replies).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(fake.layer, TestClock.layer()))),
  );
});
