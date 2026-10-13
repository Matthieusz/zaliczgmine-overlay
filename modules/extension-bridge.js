import { Effect } from "effect";
import { ExtensionBridge, extensionBridgeLayer } from "../src/extension-bridge.ts";

(function (app, protocol) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("extension-bridge");
  const layer = extensionBridgeLayer(window, log, () => Math.random().toString(36).slice(2));

  function fetchResource(url, responseType = "json") {
    return Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* ExtensionBridge;

        return yield* bridge.fetchResource(url, responseType);
      }).pipe(Effect.provide(layer)),
    );
  }

  function getStorage(keys) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* ExtensionBridge;

        return yield* bridge.getStorage(keys);
      }).pipe(Effect.provide(layer)),
    );
  }

  // The page protocol has no write acknowledgement.
  function setStorage(data) {
    window.postMessage({ type: protocol.MESSAGE.STORAGE_SET, data }, window.location.origin);
  }

  app.modules.extensionBridge = { fetchResource, getStorage, setStorage };
})(window.ZaliczGmine, globalThis.ZaliczGmineMessageProtocol);
