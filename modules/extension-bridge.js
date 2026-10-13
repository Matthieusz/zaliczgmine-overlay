import { NetworkError, StorageError, remoteFailure } from "../src/user-errors.ts";

(function (app, protocol) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("extension-bridge");

  const { MESSAGE } = protocol;

  function createRequestId() {
    return Math.random().toString(36).slice(2);
  }

  function request(type, responseType, data, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = createRequestId();
      log.debug("Sending request", { type, requestId });
      let timeoutId;

      const handler = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;

        if (event.data.type !== responseType || event.data.requestId !== requestId) return;

        window.removeEventListener("message", handler);
        window.clearTimeout(timeoutId);

        log.debug("Extension response", {
          type,
          requestId,
          success: !event.data.error && event.data.response?.success !== false,
        });

        if (event.data.error) {
          reject(
            type === MESSAGE.STORAGE_GET
              ? new StorageError({ operation: "read" })
              : new NetworkError({ reason: "unavailable" }),
          );
        } else {
          resolve(event.data);
        }
      };

      window.addEventListener("message", handler);
      window.postMessage({ type, requestId, ...data }, window.location.origin);

      timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", handler);
        log.warn("Request timed out", { type, requestId, timeoutMs });
        reject(
          type === MESSAGE.STORAGE_GET
            ? new StorageError({ operation: "read" })
            : new NetworkError({ reason: "timeout" }),
        );
      }, timeoutMs);
    });
  }

  //
  // Storage and page-to-extension transport
  //
  async function fetchResource(url, responseType = "json") {
    const message = await request(
      MESSAGE.FETCH_REQUEST,
      MESSAGE.FETCH_RESPONSE,
      { url, responseType },
      30000,
    );

    if (!message.response || !message.response.success) {
      throw remoteFailure(message.response);
    }

    return message.response.data;
  }

  async function getStorage(keys) {
    const message = await request(MESSAGE.STORAGE_GET, MESSAGE.STORAGE_RESPONSE, { keys }, 5000);

    return message.data || {};
  }

  function setStorage(data) {
    window.postMessage({ type: MESSAGE.STORAGE_SET, data }, window.location.origin);
  }

  app.modules.extensionBridge = {
    fetchResource,
    getStorage,
    setStorage,
  };
})(window.ZaliczGmine, globalThis.ZaliczGmineMessageProtocol);
