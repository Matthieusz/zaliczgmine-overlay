import { Effect } from "effect";
import { chromeRuntimeLayer } from "../src/chrome-runtime.ts";
import { fetchRuntimeJson } from "../src/runtime-fetch.ts";
import { InvalidApiData, apiFailure } from "../src/user-errors.ts";

(function (global) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("zaliczgmine-api");

  function fetchViaRuntime(url) {
    return Effect.runPromise(
      fetchRuntimeJson(url).pipe(Effect.provide(chromeRuntimeLayer(chrome.runtime))),
    );
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
