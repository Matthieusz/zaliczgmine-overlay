import { Effect } from "effect";
import { backgroundLifetime } from "./background-listener.ts";
import { chromeRuntimeLayer } from "./chrome-runtime.ts";

// This scope lasts for the service worker's lifetime; each fetch is bounded to 30 seconds.
Effect.runFork(
  backgroundLifetime((url, signal) => fetch(url, { signal })).pipe(
    Effect.scoped,
    Effect.provide(chromeRuntimeLayer(chrome.runtime)),
  ),
);
