import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Exit } from "effect";
import { extensionUrl } from "../src/chrome-extension-url.ts";

const Paths = ["i18n.js", "modules/map-finder.js", "map-app.js"];

test("extension URL lookup is lazy, preserves paths and the native receiver, and returns Chrome's URL", () => {
  const paths: string[] = [];

  const api = {
    prefix: "chrome-extension://test/",
    getURL(path: string) {
      paths.push(path);

      return this.prefix + path;
    },
  };

  const effects = Paths.map((path) => extensionUrl(api, path));
  expect(paths).toEqual([]);
  expect(effects.map((effect) => Effect.runSync(effect))).toEqual(
    Paths.map((path) => api.prefix + path),
  );
  expect(paths).toEqual(Paths);
});

test("native URL lookup exceptions remain script-loading defects", () => {
  const error = new Error("native lookup failed");

  const exit = Effect.runSyncExit(
    extensionUrl(
      {
        getURL: () => {
          throw error;
        },
      },
      "map-app.js",
    ),
  );

  expect(Exit.hasDies(exit)).toBe(true);
});

test("malformed native URL values fail at the adapter boundary", () => {
  for (const result of [undefined, null, 42, {}]) {
    const exit: unknown = runInNewContext(
      "Effect.runSyncExit(extensionUrl({ getURL: () => result }, 'map-app.js'))",
      { Effect, extensionUrl, result },
    );

    expect(Exit.isExit(exit) && Exit.hasDies(exit)).toBe(true);
  }
});
