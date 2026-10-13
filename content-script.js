import { Effect, Fiber, FiberSet } from "effect";
import { ChromeStorage, chromeStorageLayer } from "./src/chrome-storage.ts";
import { failureReply, NetworkError } from "./src/user-errors.ts";

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
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    if (event.data.type === MESSAGE.FETCH_REQUEST) {
      const { requestId, url, responseType } = event.data;
      chrome.runtime.sendMessage(
        {
          type: MESSAGE.FETCH,
          url,
          responseType,
        },
        (response) => {
          window.postMessage(
            {
              type: MESSAGE.FETCH_RESPONSE,
              requestId,
              response,
              error: chrome.runtime.lastError ? "extension.noResponse" : undefined,
            },
            window.location.origin,
          );
        },
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
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isSupportedRoute()) {
      sendResponse({
        success: false,
        connected: false,
        error: "extension.unsupportedPage",
      });

      return false;
    }

    log.debug("Forwarding command", { action: request.action });
    const scriptsReady = loadScripts();
    const requestId = Math.random().toString(36).slice(2);

    // setup listener for response
    const handler = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;

      if (event.data.type !== MESSAGE.COMMAND_RESPONSE) return;

      if (event.data.requestId !== requestId) return;

      window.removeEventListener("message", handler);
      clearTimeout(timeoutId);
      sendResponse(event.data.response);
    };

    window.addEventListener("message", handler);

    // send request
    // ACTION: GET_STATUS, TOGGLE_COMMUNES, RELOAD_COMMUNES, IMPORT_GPX, REMOVE_GPX
    scriptsReady
      .then(() => {
        window.postMessage(
          {
            type: MESSAGE.COMMAND,
            requestId,
            action: request.action,
            data: request.data,
          },
          window.location.origin,
        );
      })
      .catch((error) => {
        window.removeEventListener("message", handler);
        clearTimeout(timeoutId);
        sendResponse(failureReply(error));
      });

    const timeoutId = setTimeout(() => {
      log.warn("Command timed out", { action: request.action, requestId });
      window.removeEventListener("message", handler);
      sendResponse(failureReply(new NetworkError({ reason: "timeout" })));
    }, 5000);

    return true;
  });

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(src);
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
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
        await injectScript(script);
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
      loadScripts();
    }
  }

  function watchRouteChanges() {
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      log.debug("Page changed", { supported: isSupportedRoute() });
      loadScriptsIfSupported();
    }, 1000);
  }

  loadScriptsIfSupported();
  watchRouteChanges();

  yield* Effect.never;
});

Effect.runFork(
  contentLifetime.pipe(
    Effect.scoped,
    Effect.provide(chromeStorageLayer(chrome.storage, chrome.runtime)),
  ),
  { signal: lifetime.signal },
);
