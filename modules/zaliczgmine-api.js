import { Effect } from "effect";
import { chromeRuntimeLayer } from "../src/chrome-runtime.ts";
import { fetchRuntimeJson } from "../src/runtime-fetch.ts";
import { createApi } from "../src/zaliczgmine-api.ts";

(function (global) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("zaliczgmine-api");

  function fetchViaRuntime(url) {
    return Effect.runPromise(
      fetchRuntimeJson(url).pipe(Effect.provide(chromeRuntimeLayer(chrome.runtime))),
    );
  }

  function createZaliczGmineApi(fetchResource = fetchViaRuntime) {
    const workflows = createApi(global.ZaliczGmineI18n.apiBase, fetchResource);

    async function run(endpoint, effect) {
      log.debug("API request", { endpoint });

      try {
        return await Effect.runPromise(effect);
      } catch (error) {
        log.error("API operation failed", { endpoint });
        throw error;
      }
    }

    return {
      searchUsers: (query) => run("usersearch", workflows.searchUsers(query)),
      getVisitedCommunes: (userId, country) =>
        run("usercommunes", workflows.getVisitedCommunes(String(userId), country)),
      getPolygons: (zoom, country, bounds) =>
        run("geompolygons", workflows.getPolygons(zoom, country, bounds)),
    };
  }

  global.createZaliczGmineApi = createZaliczGmineApi;
})(globalThis);
