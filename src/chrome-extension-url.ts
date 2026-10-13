import { Effect, Schema } from "effect";

/** Lazily resolves a trusted extension-relative path. Native throws or invalid result types remain script-loading defects. */
export const extensionUrl = Effect.fn("ChromeRuntime.getURL")(function* (
  api: Pick<typeof chrome.runtime, "getURL">,
  path: string,
) {
  const url = yield* Effect.sync(() => api.getURL(path));

  return yield* Schema.decodeEffect(Schema.String)(url).pipe(Effect.orDie);
});
