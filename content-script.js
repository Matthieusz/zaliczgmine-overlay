import { Effect, Fiber, FiberSet, Layer, Predicate, Schedule } from "effect";
import { ChromeStorage, chromeStorageLayer } from "./src/chrome-storage.ts";
import { ChromeRuntime, chromeRuntimeLayer } from "./src/chrome-runtime.ts";
import { extensionUrl } from "./src/chrome-extension-url.ts";
import { forwardCommand } from "./src/content-command.ts";
import { failureReply } from "./src/user-errors.ts";

const lifetime = new AbortController();

const contentLifetime = Effect.gen(function* () {
  "use strict";

  const onUnload = () => lifetime.abort();
  yield* Effect.acquireRelease(
    Effect.sync(() => window.addEventListener("unload", onUnload, { once: true })),
    () => Effect.sync(() => window.removeEventListener("unload", onUnload)),
  );

  const log = globalThis.ZaliczGmineLogger.create("content-script");

  const { MESSAGE } = globalThis.ZaliczGmineMessageProtocol;

  const pageScripts = [
    "i18n.js",
    "logger.js",
    "message-protocol.js",
    "config.js",
    "modules/sites.js",
    "modules/extension-bridge.js",
    "modules/zaliczgmine-api.js",
    "modules/map-finder.js",
    "modules/communes-geometry.js",
    "modules/communes-data.js",
    "modules/map-layers.js",
    "modules/route-geometry.js",
    "modules/planned-route.js",
    "lib/togeojson.js",
    "modules/gpx.js",
    "map-app.js",
  ];

  const { isSupportedPage } = globalThis.ZaliczGmineSites;

  const storage = yield* ChromeStorage;
  const runtime = yield* ChromeRuntime;
  const runStorage = yield* FiberSet.makeRuntime();

  const languageReady = runStorage(
    storage
      .getPromise("language")
      .pipe(
        Effect.tap((settings) =>
          Effect.sync(() => globalThis.ZaliczGmineI18n.setLanguage(settings.language)),
        ),
      ),
  );

  let scriptsLoaded = false;
  const loadedScripts = new Set();
  let scriptsLoading = null;
  let lastPath = location.pathname;

  // function getPathWithoutLocale() {
  //   return location.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '');
  // }

  // function isSupportedRoute() {
  //   const path = getPathWithoutLocale();
  //   return /^\/tour\/[^/]+\/edit(?:\/|$)/.test(path) ||
  //     /^\/plan(?:\/|$)/.test(path);
  // }

  function isSupportedRoute() {
    return isSupportedPage(window.location);
  }

  // get communes & visited communes using background.js as a bridge, because blockade cross-origin requests
  const onPageMessage = (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    if (!event.data) return;

    if (event.data.type === MESSAGE.FETCH_REQUEST) {
      const { requestId, url, responseType } = event.data;
      const request = { type: MESSAGE.FETCH, url };

      if (responseType !== undefined) request.responseType = responseType;

      runStorage(
        runtime.sendFetch(request).pipe(
          Effect.match({
            onSuccess: (response) =>
              window.postMessage(
                { type: MESSAGE.FETCH_RESPONSE, requestId, response, error: undefined },
                window.location.origin,
              ),
            onFailure: (error) =>
              window.postMessage(
                {
                  type: MESSAGE.FETCH_RESPONSE,
                  requestId,
                  response: Predicate.isTagged(error, "NetworkError")
                    ? undefined
                    : failureReply(error),
                  error: Predicate.isTagged(error, "NetworkError")
                    ? "extension.noResponse"
                    : undefined,
                },
                window.location.origin,
              ),
          }),
        ),
      );

      return;
    }

    // storage
    if (event.data.type === MESSAGE.STORAGE_GET) {
      runStorage(
        storage.get(event.data.keys || null).pipe(
          Effect.match({
            onSuccess: (result) =>
              window.postMessage(
                {
                  type: MESSAGE.STORAGE_RESPONSE,
                  requestId: event.data.requestId,
                  data: { ...result, resolvedLanguage: globalThis.ZaliczGmineI18n.language },
                  error: undefined,
                },
                window.location.origin,
              ),
            onFailure: () =>
              window.postMessage(
                {
                  type: MESSAGE.STORAGE_RESPONSE,
                  requestId: event.data.requestId,
                  data: undefined,
                  error: "storage.error",
                },
                window.location.origin,
              ),
          }),
        ),
      );

      return;
    }

    if (event.data.type === MESSAGE.STORAGE_SET) {
      // The page protocol has no write acknowledgement.
      runStorage(
        storage
          .setPromise(event.data.data)
          .pipe(
            Effect.catchTag("StorageError", () =>
              Effect.sync(() => log.warn("Storage write failed")),
            ),
          ),
      );
    }
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => window.addEventListener("message", onPageMessage)),
    () => Effect.sync(() => window.removeEventListener("message", onPageMessage)),
  );

  yield* runtime.listen((request, sendResponse) => {
    if (!isSupportedRoute()) {
      sendResponse({
        success: false,
        connected: false,
        error: "extension.unsupportedPage",
      });

      return false;
    }

    log.debug("Forwarding command", { action: request?.action });
    const requestId = Math.random().toString(36).slice(2);

    runStorage(
      forwardCommand(
        request,
        Effect.promise(() => loadScripts()),
        window,
        requestId,
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (Predicate.isTagged(error, "NetworkError") && error.reason === "timeout") {
              log.warn("Command timed out", { action: request.action, requestId });
            }
          }),
        ),
        Effect.match({ onSuccess: (response) => response, onFailure: failureReply }),
        Effect.catchDefect((error) => Effect.succeed(failureReply(error))),
        Effect.tap((response) => Effect.sync(() => sendResponse(response))),
      ),
    );

    return true;
  });

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = Effect.runSync(extensionUrl(chrome.runtime, src));
      script.defer = true;

      const cleanup = () => {
        script.onload = script.onerror = null;
        lifetime.signal.removeEventListener("abort", onAbort);
        script.remove();
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };

      script.onload = () => {
        cleanup();
        resolve();
      };

      script.onerror = () => {
        cleanup();
        reject(new Error(`Could not load ${src}`));
      };

      if (lifetime.signal.aborted) {
        onAbort();

        return;
      }

      lifetime.signal.addEventListener("abort", onAbort, { once: true });
      (document.head || document.documentElement).appendChild(script);
    });
  }

  async function loadScripts() {
    if (scriptsLoaded) return;

    if (scriptsLoading) return scriptsLoading;

    if (!isSupportedRoute()) return;

    scriptsLoading = (async () => {
      await Effect.runPromise(Fiber.join(languageReady));

      for (const script of pageScripts) {
        if (loadedScripts.has(script)) continue;
        await injectScript(script);
        loadedScripts.add(script);
        log.debug("Script loaded", { script });
      }

      scriptsLoaded = true;
      log.debug("Page scripts loaded");
    })();

    try {
      await scriptsLoading;
    } catch (error) {
      scriptsLoading = null;
      log.error("Could not load scripts", error);
      throw error;
    }
  }

  function loadScriptsIfSupported() {
    if (isSupportedRoute()) {
      runStorage(Effect.tryPromise(() => loadScripts()).pipe(Effect.catch(() => Effect.void)));
    }
  }

  function watchRouteChanges() {
    return Effect.sync(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      log.debug("Page changed", { supported: isSupportedRoute() });
      loadScriptsIfSupported();
    }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  }

  loadScriptsIfSupported();
  yield* watchRouteChanges();

  yield* Effect.never;
});

Effect.runFork(
  contentLifetime.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        chromeStorageLayer(chrome.storage, chrome.runtime),
        chromeRuntimeLayer(chrome.runtime),
      ),
    ),
  ),
  { signal: lifetime.signal },
);
