import { Effect, Result } from "effect";
import { loadInitialMap, startupStep } from "./src/map-startup.ts";
import { failureReply, MapNotReady } from "./src/user-errors.ts";

(function (app) {
  "use strict";

  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("map-app");

  const { ACTION, MESSAGE } = globalThis.ZaliczGmineMessageProtocol;

  const {
    loadVisitedCommunes,
    reloadVisitedCommunes,
    fetchPolygons,
    activatePolygons,
    getPolygonRequestForMap,
  } = app.modules.communesData;

  const { getTracksSummary, loadStoredGpx, removeGpx, renderGpx, setGpx } = app.modules.gpx;
  const { findMap } = app.modules.mapFinder;

  const {
    addCommunesLayers,
    addToggleButton,
    refreshCommunesStyles,
    setupStyleChangeObserver,
    setupZoomObserver,
    showNotification,
    toggleLayers,
    waitForStyleLoad,
  } = app.modules.mapLayers;

  const languageReady = app.modules.extensionBridge.getStorage(["language"]).then((settings) => {
    globalThis.ZaliczGmineI18n.setLanguage(settings.resolvedLanguage || settings.language);
  });

  async function handleCommand(action, data = {}) {
    await languageReady;
    log.debug("Handling command", { action });

    if (action === ACTION.TOGGLE_COMMUNES) {
      if (!app.state.map) {
        return failureReply(new MapNotReady({}));
      }

      toggleLayers(!app.state.communesVisible);

      return { success: true, visible: app.state.communesVisible };
    }

    if (action === ACTION.RELOAD_COMMUNES) {
      try {
        await reloadVisitedCommunes(data.userId);
        refreshCommunesStyles();

        return {
          success: true,
          visitedCommunesCount: app.state.visitedCommunesIds.size,
          userId: app.state.userId,
          visitedCommunesSource: app.state.visitedCommunesSource,
        };
      } catch (error) {
        return failureReply(error);
      }
    }

    if (action === ACTION.IMPORT_GPX) {
      try {
        const gpx = setGpx(data.text, data.name, data.id);

        return { success: true, gpx };
      } catch (error) {
        return failureReply(error);
      }
    }

    if (action === ACTION.REMOVE_GPX) {
      removeGpx(data.id);

      return { success: true, gpxTracks: getTracksSummary() };
    }

    if (action === ACTION.GET_STATUS) {
      return {
        connected: !!app.state.map,
        visible: app.state.communesVisible,
        visitedCommunesCount: app.state.visitedCommunesIds.size,
        userId: app.state.userId,
        visitedCommunesSource: app.state.visitedCommunesSource,
        gpxTracks: getTracksSummary(),
        totalLoaded: app.state.polygons ? app.state.polygons.length : 0,
      };
    }

    return { success: false, error: "extension.unknownAction" };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    if (event.data.type !== MESSAGE.COMMAND) return;

    try {
      const response = await handleCommand(event.data.action, event.data.data);
      window.postMessage(
        {
          type: MESSAGE.COMMAND_RESPONSE,
          requestId: event.data.requestId,
          response,
        },
        window.location.origin,
      );
    } catch (error) {
      window.postMessage(
        {
          type: MESSAGE.COMMAND_RESPONSE,
          requestId: event.data.requestId,
          response: failureReply(error),
        },
        window.location.origin,
      );
    }
  });

  async function init() {
    await languageReady;
    log.debug("Starting initialization");

    for (let attempt = 0; attempt < 120; attempt++) {
      const map = await findMap();

      if (!map) {
        if (attempt % 20 === 0) log.debug("Waiting for map", { attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      log.debug("Map found", { attempt: attempt + 1 });
      await waitForStyleLoad();
      log.debug("Map style ready");
      app.modules.plannedRoute.start();

      let visitedResult = null;

      async function loadStartupData() {
        try {
          const outcome = await Effect.runPromise(
            loadInitialMap(
              visitedResult && Result.isSuccess(visitedResult)
                ? Effect.succeed(visitedResult.success)
                : startupStep(loadVisitedCommunes),
              startupStep(async () => {
                await waitForStyleLoad();
                const request = getPolygonRequestForMap(map);
                const polygons = await fetchPolygons(request, true);

                return { request, polygons };
              }),
            ),
          );

          visitedResult = outcome.visited;
          log.debug("Initial map data", { status: outcome.status });
          refreshCommunesStyles();

          if (Result.isFailure(outcome.boundaries)) {
            const boundaryMessage = t("communes.initialBoundariesError", {
              error: t(failureReply(outcome.boundaries.failure).error),
            });

            const visitedMessage = Result.isFailure(outcome.visited)
              ? t("communes.visitedLoadError", {
                  error: t(failureReply(outcome.visited.failure).error),
                })
              : t("communes.loadedSummary", { count: app.state.visitedCommunesIds.size });

            showNotification(`${boundaryMessage} ${visitedMessage}`, loadStartupData);

            return;
          }

          const { request, polygons } = outcome.boundaries.success;
          activatePolygons(request, polygons);
          addCommunesLayers();
          showNotification(
            Result.isFailure(outcome.visited)
              ? t("communes.visitedLoadError", {
                  error: t(failureReply(outcome.visited.failure).error),
                })
              : t("communes.loadedSummary", { count: app.state.visitedCommunesIds.size }),
            Result.isFailure(outcome.visited) ? loadStartupData : undefined,
          );
        } catch (error) {
          log.error("Initial map setup failed", error);
          showNotification(t("extension.unexpectedError"), loadStartupData);
        }
      }

      addToggleButton();
      setupStyleChangeObserver();
      setupZoomObserver();

      try {
        await loadStoredGpx();
      } catch (error) {
        log.error("Could not load saved GPX:", error);
        showNotification(t("gpx.someTracksUnavailable"), undefined, "gpx");
      }

      await loadStartupData();

      log.debug("Extension ready");

      return;
    }

    log.debug("Map not found");
  }

  window.zaliczGmine = app.state;
  window.zaliczGmineToggle = () => toggleLayers(!app.state.communesVisible);
  window.zaliczGmineRenderGpx = renderGpx;

  setTimeout(init, 0);
})(window.ZaliczGmine);
