import { Effect, Result } from "effect";
import { awaitMapReady } from "./src/map-lifetime.ts";
import { loadInitialMap, startupStep } from "./src/map-startup.ts";
import { failureReply, MapNotReady } from "./src/user-errors.ts";

(function (app) {
  "use strict";

  const lifetime = new AbortController();
  const shutdown = () => lifetime.abort();

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

  const onCommand = async (event) => {
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
  };

  async function init() {
    await languageReady;
    log.debug("Starting initialization");

    {
      const map = await Effect.runPromise(awaitMapReady(Effect.promise(findMap), "discovery"), {
        signal: lifetime.signal,
      });

      if (lifetime.signal.aborted) return;
      map.on("remove", shutdown);
      log.debug("Map found");
      await waitForStyleLoad(lifetime.signal);
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
                await waitForStyleLoad(lifetime.signal);
                const request = getPolygonRequestForMap(map);
                const polygons = await fetchPolygons(request);

                return { request, polygons };
              }),
            ),
          );

          if (lifetime.signal.aborted) return;
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
          if (lifetime.signal.aborted) return;
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

      if (lifetime.signal.aborted) return;
      await loadStartupData();

      log.debug("Extension ready");

      return;
    }
  }

  window.zaliczGmine = app.state;
  window.zaliczGmineToggle = () => toggleLayers(!app.state.communesVisible);
  window.zaliczGmineRenderGpx = renderGpx;

  Effect.runFork(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          window.addEventListener("unload", shutdown, { once: true });
          window.addEventListener("message", onCommand);
        }),
        () =>
          Effect.sync(() => {
            lifetime.abort();
            window.removeEventListener("unload", shutdown);
            window.removeEventListener("message", onCommand);
            app.state.map?.off("remove", shutdown);
            app.modules.mapLayers.stop();
            app.modules.plannedRoute.stop();
            app.state.map = null;
          }),
      );
      yield* Effect.promise(init);
      yield* Effect.never;
    }).pipe(
      Effect.scoped,
      Effect.catchDefect((error) =>
        Effect.sync(() => {
          if (!lifetime.signal.aborted) log.error("Map initialization failed", error);
        }),
      ),
    ),
    { signal: lifetime.signal },
  );
})(window.ZaliczGmine);
