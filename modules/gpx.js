(function (app) {
  "use strict";

  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("gpx");

  const { layerIds, sourceIds, styles } = app.config;
  const { getStorage } = app.modules.extensionBridge;
  let tracks = [];

  function parseGpx(gpxText) {
    const doc = new DOMParser().parseFromString(gpxText, "application/xml");

    if (doc.querySelector("parsererror")) {
      throw new Error(t("gpx.invalidFile"));
    }

    // mapbox/togeojson (BSD-2-Clause); see lib header and THIRD_PARTY_LICENSES.txt.
    const geojson = globalThis.toGeoJSON.gpx(doc);

    // Waypoints are not routes. Preserve MultiLineString segment boundaries.
    const features = geojson.features.filter(
      (feature) =>
        feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString",
    );

    if (features.length === 0) {
      throw new Error(t("gpx.noTrack"));
    }

    return { type: "FeatureCollection", features };
  }

  function getEmptyFeatureCollection() {
    return { type: "FeatureCollection", features: [] };
  }

  function getGpxFeatureCollection() {
    const features = [];

    for (const track of tracks) {
      for (const feature of track.geojson.features) {
        features.push({
          ...feature,
          properties: {
            ...feature.properties,
            id: track.id,
            name: track.name,
          },
        });
      }
    }

    return { type: "FeatureCollection", features };
  }

  function removeGpxLayers() {
    if (!app.state.map) return;

    for (const layerId of [layerIds.gpxLine, layerIds.gpxCasing]) {
      if (app.state.map.getLayer(layerId)) {
        app.state.map.removeLayer(layerId);
      }
    }

    if (app.state.map.getSource(sourceIds.gpx)) {
      app.state.map.removeSource(sourceIds.gpx);
    }
  }

  function renderGpx() {
    if (!app.state.map) return;

    const data = tracks.length > 0 ? getGpxFeatureCollection() : getEmptyFeatureCollection();

    const source = app.state.map.getSource(sourceIds.gpx);

    if (source) {
      source.setData(data);
    } else {
      app.state.map.addSource(sourceIds.gpx, {
        type: "geojson",
        data,
      });
    }

    if (!app.state.map.getLayer(layerIds.gpxCasing)) {
      app.state.map.addLayer({
        id: layerIds.gpxCasing,
        type: "line",
        source: sourceIds.gpx,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: styles.gpxCasing,
      });
    }

    if (!app.state.map.getLayer(layerIds.gpxLine)) {
      app.state.map.addLayer({
        id: layerIds.gpxLine,
        type: "line",
        source: sourceIds.gpx,
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: styles.gpxLine,
      });
    }
  }

  function setGpx(gpxText, name, id) {
    if (!gpxText || !gpxText.trim()) {
      throw new Error("Plik GPX jest pusty");
    }

    const geojson = parseGpx(gpxText);

    const segmentsCount = geojson.features.reduce(
      (count, feature) =>
        count +
        (feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates.length : 1),
      0,
    );

    log.debug("GPX loaded", { segmentsCount });

    const track = {
      id: id || Math.random().toString(36).slice(2),
      name: name || "track.gpx",
      text: gpxText,
      geojson,
    };

    const existingIndex = tracks.findIndex((item) => item.id === track.id);

    if (existingIndex >= 0) {
      tracks[existingIndex] = track;
    } else {
      tracks.push(track);
    }

    renderGpx();

    return {
      id: track.id,
      name: track.name,
      tracksCount: segmentsCount,
    };
  }

  function removeGpx(id) {
    log.debug("Removing GPX", { all: !id, tracksCount: tracks.length });

    if (id) {
      const tracksCount = tracks.length;
      tracks = tracks.filter((track) => track.id !== id);

      if (tracksCount === tracks.length && tracksCount === 1) {
        tracks = [];
      }

      renderGpx();

      return;
    }

    removeGpxLayers();
    tracks = [];
  }

  async function loadStoredGpx() {
    const storage = await getStorage(["zaliczGmineGpxList"]);

    const storedTracks = Array.isArray(storage.zaliczGmineGpxList)
      ? storage.zaliczGmineGpxList
      : [];

    tracks = [];

    for (const track of storedTracks) {
      if (!track || !track.text) continue;

      try {
        setGpx(track.text, track.name, track.id);
      } catch (error) {
        log.error(`Skipped GPX "${track.name || "track.gpx"}":`, error);
      }
    }

    renderGpx();

    return getTracksSummary();
  }

  function getTracksSummary() {
    return tracks.map((track) => ({
      id: track.id,
      name: track.name,
    }));
  }

  app.modules.gpx = {
    getTracksSummary,
    loadStoredGpx,
    removeGpx,
    renderGpx,
    setGpx,
  };
})(window.ZaliczGmine);
