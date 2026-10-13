import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Exit, Fiber, Match, Predicate, Schema } from "effect";
import { ChromeStorage, chromeStorageLayer, type ChromeStorageApi } from "../src/chrome-storage.ts";
import { StorageError, failureReply } from "../src/user-errors.ts";

type Values = Parameters<ChromeStorageApi["local"]["set"]>[0];

type MutableValues = { -readonly [Key in keyof Values]: Values[Key] };

type Keys = Parameters<ChromeStorageApi["local"]["get"]>[0];

type RemoveKeys = Parameters<ChromeStorageApi["local"]["remove"]>[0];

type ChangeListener = Parameters<ChromeStorageApi["onChanged"]["addListener"]>[0];

class StorageFake {
  values: MutableValues = {};
  failure: StorageError["operation"] | undefined;
  hold = false;
  throws = false;
  calls = 0;
  errorReads = 0;
  private error: chrome.runtime.LastError | undefined;
  readonly pending: Array<() => void> = [];
  readonly listeners = new Set<ChangeListener>();
  readonly runtime: Pick<typeof chrome.runtime, "lastError">;

  constructor() {
    // Use a capability getter, not a spy: Chrome's error only exists within a callback.
    const readError = () => {
      this.errorReads++;

      return this.error;
    };

    this.runtime = {
      get lastError() {
        return readError();
      },
    };
  }

  private callback(operation: StorageError["operation"], complete: () => void) {
    const invoke = () => {
      this.error = this.failure === operation ? { message: "private browser error" } : undefined;

      try {
        complete();
      } finally {
        this.error = undefined;
      }
    };

    if (this.hold) this.pending.push(invoke);
    else invoke();
  }

  readonly api: ChromeStorageApi = {
    local: {
      get: (keys: Keys, callback?: (values: Values) => void) => {
        this.calls++;

        if (this.throws) throw new Error("private storage error");

        const result: MutableValues = {};

        if (keys === null) Object.assign(result, this.values);
        else if (Predicate.isString(keys)) {
          if (Object.hasOwn(this.values, keys)) result[keys] = this.values[keys];
        } else if (Array.isArray(keys)) {
          for (const key of keys) {
            if (Object.hasOwn(this.values, key)) result[key] = this.values[key];
          }
        } else {
          Object.assign(result, keys);

          for (const key of Object.keys(result)) {
            if (Object.hasOwn(this.values, key)) result[key] = this.values[key];
          }
        }

        if (callback) {
          this.callback("read", () => callback(result));

          return Promise.resolve(result);
        }

        if (this.hold)
          return new Promise<Values>((resolve) => this.pending.push(() => resolve(result)));

        return this.failure === "read"
          ? Promise.reject(new Error("private browser error"))
          : Promise.resolve(result);
      },
      set: (values: Values, callback?: () => void) => {
        this.calls++;

        if (this.throws) throw new Error("private storage error");

        if (this.failure !== "write") Object.assign(this.values, values);

        if (callback) {
          this.callback("write", callback);

          return Promise.resolve();
        }

        return this.failure === "write"
          ? Promise.reject(new Error("private browser error"))
          : Promise.resolve();
      },
      remove: (keys: RemoveKeys, callback: () => void) => {
        this.calls++;

        if (this.throws) throw new Error("private storage error");

        if (this.failure !== "remove") {
          for (const key of Schema.decodeSync(Schema.Array(Schema.String))(
            Array.isArray(keys) ? keys : [keys],
          )) {
            delete this.values[key];
          }
        }

        this.callback("remove", callback);
      },
    },
    onChanged: {
      addListener: (listener) => void this.listeners.add(listener),
      removeListener: (listener) => void this.listeners.delete(listener),
    },
  };

  get layer() {
    return chromeStorageLayer(this.api, this.runtime);
  }
}

test("storage preserves keys, defaults, opaque values, and successful callback/promise calls", async () => {
  const fake = new StorageFake();
  const tracks = [{ id: "track-1", name: "ride.gpx", text: "<gpx/>" }];

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;
      yield* storage.setPromise({ language: "pl" });
      yield* storage.set({
        zaliczGmineUserId: "42",
        zaliczGmineUsername: "Rider",
        zaliczGmineGpxList: tracks,
      });
      expect(yield* storage.getPromise("language")).toEqual({ language: "pl" });
      expect(yield* storage.get(["zaliczGmineUserId", "zaliczGmineUsername"])).toEqual({
        zaliczGmineUserId: "42",
        zaliczGmineUsername: "Rider",
      });
      expect(yield* storage.get({ missing: "default", language: "auto" })).toEqual({
        missing: "default",
        language: "pl",
      });
      expect(yield* storage.get(null)).toEqual(fake.values);
      yield* storage.remove(["zaliczGmineGpxList"]);
      expect(yield* storage.get("zaliczGmineGpxList")).toEqual({});
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(fake.runtime.lastError).toBeUndefined();
});

test("callback lastError and promise rejection become safe operation-specific failures", async () => {
  for (const operation of ["read", "write", "remove"] as const) {
    const fake = new StorageFake();
    fake.failure = operation;

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ChromeStorage;

        const effect = Match.value(operation).pipe(
          Match.when("read", () => storage.get(null)),
          Match.when("write", () => storage.set({ language: "pl" })),
          Match.when("remove", () => storage.remove("language")),
          Match.exhaustive,
        );

        const error = yield* Effect.flip(effect);
        expect(error).toEqual(new StorageError({ operation }));
        expect(failureReply(error).error).toBe("storage.error");
        expect(JSON.stringify(failureReply(error))).not.toContain("private browser error");
        expect(fake.errorReads).toBe(1);
        expect(fake.runtime.lastError).toBeUndefined();

        if (operation !== "remove") {
          const promise =
            operation === "read"
              ? storage.getPromise(null)
              : storage.setPromise({ language: "en" });

          expect(yield* Effect.flip(promise)).toEqual(new StorageError({ operation }));
        }
      }).pipe(Effect.provide(fake.layer)),
    );
  }
});

test("malformed storage inputs fail before Chrome I/O", async () => {
  const fake = new StorageFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;

      for (const input of [42, ["language", 42], undefined]) {
        expect(yield* Effect.flip(storage.get(input))).toEqual(
          new StorageError({ operation: "read" }),
        );
        expect(yield* Effect.flip(storage.getPromise(input))).toEqual(
          new StorageError({ operation: "read" }),
        );
      }

      for (const input of [null, "language", ["language"]]) {
        expect(yield* Effect.flip(storage.set(input))).toEqual(
          new StorageError({ operation: "write" }),
        );
        expect(yield* Effect.flip(storage.setPromise(input))).toEqual(
          new StorageError({ operation: "write" }),
        );
      }

      expect(yield* Effect.flip(storage.remove({ language: "pl" }))).toEqual(
        new StorageError({ operation: "remove" }),
      );
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(fake.calls).toBe(0);
});

test("interruption prevents late callbacks from running consumers but still consumes lastError", async () => {
  const fake = new StorageFake();
  fake.hold = true;
  fake.failure = "read";
  let completed = false;

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;

      const fiber = yield* storage.get(null).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      expect(fake.pending).toHaveLength(1);
      yield* Fiber.interrupt(fiber);

      for (const complete of fake.pending) complete();
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(completed).toBe(false);
  expect(fake.errorReads).toBe(1);
});

test("change listeners forward account changes and removals and are removed on every scoped exit", async () => {
  for (const fail of [false, true]) {
    const fake = new StorageFake();
    const events: Array<{ area: string; changes: Parameters<ChangeListener>[0] }> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* ChromeStorage;
        yield* storage.listen((changes, area) => events.push({ changes, area }));
        expect(fake.listeners.size).toBe(1);

        for (const listener of fake.listeners) {
          listener({ zaliczGmineUserId: { oldValue: "42" } }, "local");
          listener({ zaliczGmineUsername: { newValue: "Rider" } }, "sync");
        }

        runInNewContext(
          'for (const listener of listeners) { listener(null, "local"); listener({ language: 42 }, "local"); }',
          { listeners: fake.listeners },
        );

        if (fail) return yield* new StorageError({ operation: "read" });
      }).pipe(Effect.scoped, Effect.provide(fake.layer), Effect.result),
    );
    expect(events).toEqual([
      { area: "local", changes: { zaliczGmineUserId: { oldValue: "42" } } },
      { area: "sync", changes: { zaliczGmineUsername: { newValue: "Rider" } } },
    ]);
    expect(fake.listeners.size).toBe(0);
  }
});

test("synchronous Chrome invocation failures use the same storage error contract", async () => {
  const fake = new StorageFake();
  fake.throws = true;

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;

      for (const effect of [storage.get(null), storage.getPromise(null)]) {
        expect(yield* Effect.flip(effect)).toEqual(new StorageError({ operation: "read" }));
      }

      for (const effect of [
        storage.set({ language: "pl" }),
        storage.setPromise({ language: "pl" }),
      ]) {
        expect(yield* Effect.flip(effect)).toEqual(new StorageError({ operation: "write" }));
      }

      expect(yield* Effect.flip(storage.remove("language"))).toEqual(
        new StorageError({ operation: "remove" }),
      );
    }).pipe(Effect.provide(fake.layer)),
  );
});

test("a scoped listener is removed on interruption", async () => {
  const fake = new StorageFake();

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;

      const fiber = yield* Effect.gen(function* () {
        yield* storage.listen(() => {});

        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(fake.listeners.size).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(fake.listeners.size).toBe(0);
    }).pipe(Effect.provide(fake.layer)),
  );
});

test("interruption prevents a late promise resolution from running consumers", async () => {
  const fake = new StorageFake();
  fake.hold = true;
  let completed = false;

  await Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* ChromeStorage;

      const fiber = yield* storage.getPromise(null).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      expect(fake.pending).toHaveLength(1);
      yield* Fiber.interrupt(fiber);

      for (const complete of fake.pending) complete();
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
    }).pipe(Effect.provide(fake.layer)),
  );
  expect(completed).toBe(false);
});
