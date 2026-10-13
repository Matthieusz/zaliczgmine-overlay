import { Effect, Exit, Fiber, Option, Predicate, Schema, Scope } from "effect";

class RouteAnalysisError extends Schema.TaggedError()("RouteAnalysisError", {
  cause: Schema.Unknown,
}) {}

const nativeOperation = (operation) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new RouteAnalysisError({ cause }) });

const SourceReader = Schema.Struct({ getData: Schema.declare(Predicate.isFunction) });

(function (app) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("planned-route");

  const { layerIds, sourceIds, styles } = app.config;
  const routeLayers = [layerIds.routeFill, layerIds.routeOutline];
  const empty = () => ({ type: "FeatureCollection", features: [] });
  let watchedMap = null;
  let sourceId = null;
  let observerScope = null;
  let refreshFiber = null;
  let analysisFiber = null;
  let scheduled = false;
  let revision = 0;
  let readRevision = 0;
  let lastLines = null;
  let failedLines = null;
  let lastRouteSource = null;
  let matches = [];
  let renderedItems = null;
  let renderedSource = null;
  let rendering = false;

  function routeLines(data) {
    const lines = [];

    function geometry(value) {
      if (!value) return;

      if (value.type === "FeatureCollection") return value.features?.forEach(geometry);

      if (value.type === "Feature") return geometry(value.geometry);

      if (value.type === "GeometryCollection") return value.geometries?.forEach(geometry);

      if (value.type === "MultiLineString") {
        return value.coordinates?.forEach((coordinates) =>
          geometry({ type: "LineString", coordinates }),
        );
      }

      if (value.type !== "LineString" || !Array.isArray(value.coordinates)) return;
      let line = [];

      for (const point of value.coordinates) {
        if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
          line.push([point[0], point[1]]);
        } else {
          // Do not invent a segment across a gap or an invalid coordinate.
          if (line.length > 1) lines.push(line);
          line = [];
        }
      }

      if (line.length > 1) lines.push(line);
    }

    geometry(data);

    return lines;
  }

  function sameLines(a, b) {
    return (
      a &&
      a.length === b.length &&
      a.every(
        (line, i) =>
          line.length === b[i].length &&
          line.every((point, j) => point[0] === b[i][j][0] && point[1] === b[i][j][1]),
      )
    );
  }

  async function readLines(source) {
    lastRouteSource = source;

    if (!source) return [];

    // Public API where available; Komoot's older map engine exposes the
    // complete GeoJSON only through the source object. Never use tiled features.
    const reader = Schema.decodeUnknownOption(SourceReader)({ getData: source.getData });

    const data = Option.isSome(reader)
      ? await reader.value.getData.call(source)
      : source._data || source.data || source._options?.data;

    return routeLines(data);
  }

  function render() {
    const map = app.state.map;

    if (!watchedMap || rendering || !map || !map.isStyleLoaded()) return;
    rendering = true;

    try {
      renderLayers(map);
    } finally {
      rendering = false;
    }
  }

  function renderLayers(map) {
    let source = map.getSource(sourceIds.route);

    if (!source) {
      map.addSource(sourceIds.route, { type: "geojson", data: empty() });
      source = map.getSource(sourceIds.route);
    }

    const unvisitedMatches = matches.filter(
      (item) => !app.state.visitedCommunesIds.has(String(item.i)),
    );

    if (
      source !== renderedSource ||
      !renderedItems ||
      unvisitedMatches.length !== renderedItems.length ||
      unvisitedMatches.some((item, i) => item !== renderedItems[i])
    ) {
      source.setData(app.modules.communesData.convertToGeoJSON(unvisitedMatches));
      renderedSource = source;
      renderedItems = unvisitedMatches;
      app.state.routeCommunesIds = new Set(unvisitedMatches.map((item) => String(item.i)));
    }

    // Keep the route itself above its highlighted communes.
    const before = map.getStyle()?.layers?.find((layer) => layer.source === sourceId)?.id;

    for (const [id, type, paint] of [
      [layerIds.routeFill, "fill", styles.routeFill],
      [layerIds.routeOutline, "line", styles.routeOutline],
    ]) {
      if (!map.getLayer(id))
        map.addLayer(
          {
            id,
            type,
            source: sourceIds.route,
            paint,
            layout: { visibility: app.state.communesVisible ? "visible" : "none" },
          },
          before,
        );
    }
  }

  function reportFailure(error, isCurrent) {
    // Native promises may settle after their owning fiber was interrupted.
    if (!isCurrent()) return;
    failedLines = lastLines;
    lastLines = null;
    matches = [];
    render();
    log.warn("Could not analyze route", error.cause);
    const scope = observerScope;
    app.modules.mapLayers.showNotification(
      globalThis.ZaliczGmineI18n.t("route.highlightingUnavailable"),
      () => {
        if (scope !== observerScope) return Promise.resolve();
        failedLines = null;

        return refresh();
      },
      "route",
    );
  }

  const analyze = Effect.fn("PlannedRoute.analyze")(function* (lines, current, isCurrent) {
    log.debug("Analyzing updated route", { revision: current, linesCount: lines.length });

    const polygons = lines.length
      ? yield* nativeOperation(() => app.modules.communesData.fetchRoutePolygons(lines))
      : [];

    if (!isCurrent()) return;

    const result =
      lines.length && polygons.length
        ? yield* nativeOperation(() =>
            globalThis.ZaliczGmineRouteGeometry.calculate(lines, polygons, () => !isCurrent()),
          )
        : [];

    if (!result || !isCurrent()) return;
    failedLines = null;
    document.getElementById("zaliczgmine-route-notification")?.remove();
    log.debug("Route analysis completed", { revision: current, communesCount: result.length });

    if (result.length !== matches.length || result.some((item, i) => item !== matches[i]))
      matches = result;
    render();
  });

  const readRoute = Effect.fn("PlannedRoute.read")(function* (map, source, read, scope) {
    const isCurrent = () =>
      scope === observerScope &&
      map === watchedMap &&
      (map.getSource(sourceId) || null) === source &&
      app.state.communesVisible;

    const lines = yield* nativeOperation(() => readLines(source)).pipe(
      Effect.catchTag("RouteAnalysisError", (error) =>
        Effect.sync(() => reportFailure(error, () => read === readRevision && isCurrent())),
      ),
    );

    if (!lines || read !== readRevision || !isCurrent()) return;

    if (sameLines(failedLines, lines)) return;

    if (sameLines(lastLines, lines)) {
      render();

      return;
    }

    lastLines = lines;
    const current = ++revision;

    if (analysisFiber) yield* Fiber.interrupt(analysisFiber);
    const analysisCurrent = () => current === revision && isCurrent();
    analysisFiber = yield* analyze(lines, current, analysisCurrent).pipe(
      Effect.catchTag("RouteAnalysisError", (error) =>
        Effect.sync(() => reportFailure(error, analysisCurrent)),
      ),
      Effect.forkIn(scope),
    );
    yield* Fiber.await(analysisFiber);
  });

  function refresh() {
    if (!observerScope || !watchedMap || !app.state.communesVisible) return Promise.resolve();
    const map = watchedMap;
    const source = map.getSource(sourceId) || null;

    // Identical coordinates from a new source cannot reuse an obsolete analysis.
    if (source !== lastRouteSource) lastLines = null;
    const read = ++readRevision;
    const scope = observerScope;
    refreshFiber = Effect.runSync(
      Effect.gen(function* () {
        if (refreshFiber) yield* Fiber.interrupt(refreshFiber);

        return yield* readRoute(map, source, read, scope).pipe(Effect.forkIn(scope));
      }),
    );

    return Effect.runPromise(Fiber.await(refreshFiber)).then(() => undefined);
  }

  function scheduleRefresh() {
    if (!observerScope || scheduled) return;
    scheduled = true;
    // A scoped, fixed window coalesces bursts without trailing-edge starvation.
    Effect.runSync(
      Effect.callback((resume) => {
        const timer = setTimeout(() => resume(Effect.void), 60);

        return Effect.sync(() => clearTimeout(timer));
      }).pipe(
        Effect.flatMap(() => {
          scheduled = false;

          return Effect.promise(() => refresh());
        }),
        Effect.forkIn(observerScope),
      ),
    );
  }

  function onSourceData(event) {
    if (event.sourceId === sourceId) scheduleRefresh();
  }

  function onStyleData() {
    if (rendering || !watchedMap?.isStyleLoaded()) return;
    render();

    // Overlay/style mutations do not change the route. A replacement planner
    // source must still be read even if its sourcedata event was missed.
    if ((watchedMap.getSource(sourceId) || null) !== lastRouteSource) scheduleRefresh();
  }

  function setVisible(visible) {
    for (const id of routeLayers) {
      if (app.state.map?.getLayer(id))
        app.state.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }

    if (visible) scheduleRefresh();
  }

  function stop() {
    if (watchedMap) {
      watchedMap.off("sourcedata", onSourceData);
      watchedMap.off("styledata", onStyleData);
      watchedMap.off("idle", onStyleData);
      watchedMap.off("remove", stop);
    }

    const scope = observerScope;
    observerScope = null;
    watchedMap = null;
    revision++;
    readRevision++;

    if (scope) Effect.runSync(Scope.close(scope, Exit.void));
    refreshFiber = analysisFiber = null;
    scheduled = false;
    lastLines = lastRouteSource = renderedItems = renderedSource = null;
    matches = [];
    failedLines = null;
    document.getElementById("zaliczgmine-route-notification")?.remove();
    app.state.routeCommunesIds = new Set();
  }

  function start() {
    if (!app.state.map || watchedMap === app.state.map) return;
    stop();
    sourceId = globalThis.ZaliczGmineSites.getCurrentSite()?.routeSourceId;

    if (!sourceId) return;
    log.debug("Starting route observer", { sourceId });
    watchedMap = app.state.map;
    observerScope = Scope.makeUnsafe();
    watchedMap.on("sourcedata", onSourceData);
    watchedMap.on("styledata", onStyleData);
    // The new style may become ready only after its final styledata event.
    watchedMap.on("idle", onStyleData);
    watchedMap.on("remove", stop);
    void refresh();
  }

  app.modules.plannedRoute = { start, stop, scheduleRefresh, render, setVisible };
})(window.ZaliczGmine);
