import { NetworkError, InvalidApiData, apiFailure, remoteFailure } from "../src/user-errors.ts";

(function (global) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("zaliczgmine-api");

  function fetchViaRuntime(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: global.ZaliczGmineMessageProtocol.MESSAGE.FETCH,
          url,
          responseType: "json",
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;

          if (runtimeError || !response?.success) {
            reject(
              runtimeError ? new NetworkError({ reason: "unavailable" }) : remoteFailure(response),
            );

            return;
          }

          resolve(response.data);
        },
      );
    });
  }

  // Transport returns parsed JSON and rejects with optional code/http metadata.
  function createZaliczGmineApi(fetchResource = fetchViaRuntime) {
    async function get(endpoint, params) {
      const startedAt = Date.now();
      log.debug("API request", { endpoint });

      try {
        const data = await fetchResource(
          global.ZaliczGmineI18n.apiBase + endpoint + "?" + new URLSearchParams(params),
        );

        if (data?.status === "error") {
          throw apiFailure(data.code);
        }

        if (data?.status !== "success" || !Array.isArray(data.items)) {
          throw new InvalidApiData({});
        }

        log.debug("API response", {
          endpoint,
          count: data.items.length,
          durationMs: Date.now() - startedAt,
        });

        return data;
      } catch (error) {
        log.error("API operation failed", { endpoint });
        throw error;
      }
    }

    return {
      async searchUsers(query) {
        return (await get("usersearch", { q: query })).items;
      },
      getVisitedCommunes(userId, country) {
        return get("usercommunes", { user_id: userId, country });
      },
      async getPolygons(zoom, country, bounds) {
        const params = { zoom, country };

        if (bounds) params.bounds = JSON.stringify(bounds);

        return (await get("geompolygons", params)).items;
      },
    };
  }

  global.createZaliczGmineApi = createZaliczGmineApi;
})(globalThis);
