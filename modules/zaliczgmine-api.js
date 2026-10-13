(function (global) {
  "use strict";

  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("zaliczgmine-api");

  const API_ERROR_MESSAGES = {
    INVALID_REQUEST: "api.invalidRequest",
    INVALID_COUNTRY: "api.unsupportedCountry",
    USER_NOT_FOUND: "api.userNotFound",
  };

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
              Object.assign(
                new Error(runtimeError?.message || response?.error || t("api.fetchError")),
                { code: response?.code, http: response?.http },
              ),
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
          throw Object.assign(new Error(data.message || t("api.error")), { code: data.code });
        }

        if (data?.status !== "success" || !Array.isArray(data.items)) {
          throw new Error(t("api.invalidResponse"));
        }

        log.debug("API response", {
          endpoint,
          count: data.items.length,
          durationMs: Date.now() - startedAt,
        });

        return data;
      } catch (error) {
        if (Object.hasOwn(API_ERROR_MESSAGES, error.code)) {
          error.message = t(API_ERROR_MESSAGES[error.code]);
        }

        log.error("API error", {
          endpoint,
          code: error.code,
          http: error.http,
          message: error.message,
        });
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
