import { Context, Effect, Layer, Option, Schema } from "effect";
import { StorageError } from "./user-errors.ts";

const Values = Schema.Record(Schema.String, Schema.Unknown);

const Keys = Schema.Union([Schema.String, Schema.Array(Schema.String), Values, Schema.Null]);

const RemoveKeys = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const Changes = Schema.Record(
  Schema.String,
  Schema.Struct({
    oldValue: Schema.optionalKey(Schema.Unknown),
    newValue: Schema.optionalKey(Schema.Unknown),
  }),
);

/** Chrome storage capability; values remain opaque until their owning workflow decodes them. */
export interface ChromeStorageApi {
  readonly local: {
    /** Native promise read; returned dictionaries are decoded again before use. */
    get(keys: typeof Keys.Type): Promise<typeof Values.Type>;
    /** Native callback read; Chrome exposes lastError only during callback execution. */
    get(keys: typeof Keys.Type, callback: (values: typeof Values.Type) => void): void;
    /** Native promise write; completion does not acknowledge page messages. */
    set(values: typeof Values.Type): Promise<void>;
    /** Native callback write; cannot be cancelled after submission. */
    set(values: typeof Values.Type, callback: () => void): void;
    /** Native callback removal; cannot be cancelled after submission. */
    remove(keys: typeof RemoveKeys.Type, callback: () => void): void;
  };
  readonly onChanged: {
    /** Registers a native event callback; the adapter parses incoming dictionaries. */
    addListener(listener: (changes: typeof Changes.Type, area: string) => void): void;
    /** Removes the same callback that was registered. */
    removeListener(listener: (changes: typeof Changes.Type, area: string) => void): void;
  };
}

function makeChromeStorage(
  api: ChromeStorageApi,
  runtime: Pick<typeof chrome.runtime, "lastError">,
) {
  /** Reads through Chrome's promise API; API/decoding failures are StorageError(read). */
  const getPromise = Effect.fn("ChromeStorage.getPromise")(function* <Input>(input: Input) {
    const keys = yield* Schema.decodeUnknownEffect(Keys)(input).pipe(
      Effect.mapError(() => new StorageError({ operation: "read" })),
    );

    const values: unknown = yield* Effect.tryPromise({
      try: () => api.local.get(keys),
      catch: () => new StorageError({ operation: "read" }),
    });

    return yield* Schema.decodeUnknownEffect(Values)(values).pipe(
      Effect.mapError(() => new StorageError({ operation: "read" })),
    );
  });

  /** Writes through Chrome's promise API; API/decoding failures are StorageError(write). */
  const setPromise = Effect.fn("ChromeStorage.setPromise")(function* <Input>(input: Input) {
    const values = yield* Schema.decodeUnknownEffect(Values)(input).pipe(
      Effect.mapError(() => new StorageError({ operation: "write" })),
    );

    yield* Effect.tryPromise({
      try: () => api.local.set(values),
      catch: () => new StorageError({ operation: "write" }),
    });
  });

  /** Reads through callbacks and consumes lastError; failures are StorageError(read). */
  const get = Effect.fn("ChromeStorage.get")(function* <Input>(input: Input) {
    const keys = yield* Schema.decodeUnknownEffect(Keys)(input).pipe(
      Effect.mapError(() => new StorageError({ operation: "read" })),
    );

    const values = yield* Effect.callback<unknown, StorageError>((resume) => {
      try {
        api.local.get(keys, (result) => {
          // lastError exists only during this callback, including after interruption.
          const error = runtime.lastError;
          resume(
            error ? Effect.fail(new StorageError({ operation: "read" })) : Effect.succeed(result),
          );
        });
      } catch {
        resume(Effect.fail(new StorageError({ operation: "read" })));
      }
    });

    return yield* Schema.decodeUnknownEffect(Values)(values).pipe(
      Effect.mapError(() => new StorageError({ operation: "read" })),
    );
  });

  /** Writes through callbacks and consumes lastError; failures are StorageError(write). */
  const set = Effect.fn("ChromeStorage.set")(function* <Input>(input: Input) {
    const values = yield* Schema.decodeUnknownEffect(Values)(input).pipe(
      Effect.mapError(() => new StorageError({ operation: "write" })),
    );

    yield* Effect.callback<void, StorageError>((resume) => {
      try {
        api.local.set(values, () => {
          const error = runtime.lastError;
          resume(error ? Effect.fail(new StorageError({ operation: "write" })) : Effect.void);
        });
      } catch {
        resume(Effect.fail(new StorageError({ operation: "write" })));
      }
    });
  });

  /** Removes keys through callbacks and consumes lastError; failures are StorageError(remove). */
  const remove = Effect.fn("ChromeStorage.remove")(function* <Input>(input: Input) {
    const keys = yield* Schema.decodeUnknownEffect(RemoveKeys)(input).pipe(
      Effect.mapError(() => new StorageError({ operation: "remove" })),
    );

    yield* Effect.callback<void, StorageError>((resume) => {
      try {
        api.local.remove(keys, () => {
          const error = runtime.lastError;
          resume(error ? Effect.fail(new StorageError({ operation: "remove" })) : Effect.void);
        });
      } catch {
        resume(Effect.fail(new StorageError({ operation: "remove" })));
      }
    });
  });

  /** Acquires a scoped callback, ignoring malformed events; scope closure removes it. */
  const listen = Effect.fn("ChromeStorage.listen")((
    onChange: (changes: typeof Changes.Type, area: string) => void,
  ) => {
    const listener = <Input>(input: Input, area: string) => {
      const changes = Schema.decodeUnknownOption(Changes)(input);

      if (Option.isSome(changes)) onChange(changes.value, area);
    };

    return Effect.acquireRelease(
      Effect.sync(() => api.onChanged.addListener(listener)),
      () => Effect.sync(() => api.onChanged.removeListener(listener)),
    );
  });

  return { getPromise, setPromise, get, set, remove, listen };
}

/** Lazy storage operations and scoped change listeners; values are decoded again at this boundary. */
export class ChromeStorage extends Context.Service<
  ChromeStorage,
  ReturnType<typeof makeChromeStorage>
>()("ChromeStorage") {}

/** Installs the Chrome capability without I/O. Interrupted operations stop consumers, not Chrome writes. */
export function chromeStorageLayer(
  api: ChromeStorageApi,
  runtime: Pick<typeof chrome.runtime, "lastError">,
) {
  return Layer.effect(
    ChromeStorage,
    Effect.sync(() => makeChromeStorage(api, runtime)),
  );
}
