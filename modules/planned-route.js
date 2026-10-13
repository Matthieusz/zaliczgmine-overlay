import { Option, Predicate, Schema } from "effect";

const SourceReader = Schema.Struct({ getData: Schema.declare(Predicate.isFunction) });

(function (app) {
  "use strict";

  const log = globalThis.ZaliczGmineLogger.create("planned-route");

  const { layerIds, sourceIds, styles } = app.config;
  const routeLayers = [layerIds.routeFill, layerIds.routeOutline];
  const empty = () => ({ type: "FeatureCollection", features: [] });
  let watchedMap = null;
  let sourceId = null;
  let timer = null;
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

  async function readLines() {
    const source = watchedMap?.getSource(sourceId) || null;
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

  async function refresh() {
    if (!watchedMap || !app.state.communesVisible) return;
    const read = ++readRevision;
    let current;

    try {
      const lines = await readLines();

      if (read !== readRevision || !watchedMap || !app.state.communesVisible) return;

      if (sameLines(failedLines, lines)) return;

      if (sameLines(lastLines, lines)) {
        render();

        return;
      }

      lastLines = lines;
      current = ++revision;
      log.debug("Analyzing updated route", { revision: current, linesCount: lines.length });

      const polygons = lines.length ? await app.modules.communesData.fetchRoutePolygons(lines) : [];

      if (current !== revision) return;

      const result =
        lines.length && polygons.length
          ? await globalThis.ZaliczGmineRouteGeometry.calculate(
              lines,
              polygons,
              () => current !== revision,
            )
          : [];

      if (!result || current !== revision) return;
      failedLines = null;
      document.getElementById("zaliczgmine-route-notification")?.remove();
      log.debug("Route analysis completed", { revision: current, communesCount: result.length });

      if (result.length !== matches.length || result.some((item, i) => item !== matches[i]))
        matches = result;
      render();
    } catch (error) {
      // A rejected fetch for an old route must not invalidate a newer result.
      if (current !== undefined ? current !== revision : read !== readRevision) return;
      failedLines = lastLines;
      lastLines = null;
      matches = [];
      render();
      log.warn("Could not analyze route", error);
      app.modules.mapLayers.showNotification(
        globalThis.ZaliczGmineI18n.t("route.highlightingUnavailable"),
        () => {
          failedLines = null;

          return refresh();
        },
        "route",
      );
    }
  }

  function scheduleRefresh() {
    if (!watchedMap || timer !== null) return;
    // Coalesce bursts without postponing work indefinitely while dragging.
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 60);
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

    clearTimeout(timer);
    timer = null;
    watchedMap = null;
    revision++;
    readRevision++;
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
    watchedMap.on("sourcedata", onSourceData);
    watchedMap.on("styledata", onStyleData);
    // The new style may become ready only after its final styledata event.
    watchedMap.on("idle", onStyleData);
    watchedMap.on("remove", stop);
    void refresh();
  }

  app.modules.plannedRoute = { start, stop, scheduleRefresh, render, setVisible };
})(window.ZaliczGmine);
