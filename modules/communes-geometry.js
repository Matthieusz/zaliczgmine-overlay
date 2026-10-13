(function (global) {
  "use strict";

  // Shared by map rendering and route analysis, including its lazy edge index.
  const cache = new WeakMap();

  // function parseApiCoords(input) {
  //   const coords = JSON.parse(input);

  //   if (!Array.isArray(coords) || coords.length === 0) {
  //     throw new Error('Invalid coordinates');
  //   }

  //   // [[lat, lng], ...]
  //   // Single ring -> wrap it into a list of rings.
  //   if (
  //     Array.isArray(coords[0]) &&
  //     Number.isFinite(coords[0][0]) &&
  //     Number.isFinite(coords[0][1])
  //   ) {
  //     return [coords];
  //   }

  //   // [[[lat, lng], ...], ...]
  //   // Already a list of rings.
  //   if (
  //     Array.isArray(coords[0]) &&
  //     Array.isArray(coords[0][0]) &&
  //     Number.isFinite(coords[0][0][0]) &&
  //     Number.isFinite(coords[0][0][1])
  //   ) {
  //     return coords;
  //   }

  //   // [[[[lat, lng], ...]], ...]
  //   // Extra polygon nesting level -> flatten to a list of rings.
  //   if (
  //     Array.isArray(coords[0]) &&
  //     Array.isArray(coords[0][0]) &&
  //     Array.isArray(coords[0][0][0])
  //   ) {
  //     return coords.flat(1);
  //   }

  //   throw new Error('Unknown coordinate structure');
  // }

  // simplified version
  function parseApiCoords(input) {
    const data = JSON.parse(input);
    const rings = [];

    const walk = (value) => {
      if (!Array.isArray(value) || !value.length) return;

      if (Array.isArray(value[0]) && Number.isFinite(value[0][0]) && Number.isFinite(value[0][1])) {
        rings.push(value);

        return;
      }

      value.forEach(walk);
    };

    walk(data);

    return rings;
  }

  function inside([x, y], ring) {
    let result = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j],
        [bx, by] = ring[i];

      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
        result = !result;
      }
    }

    return result;
  }

  function area(ring) {
    const [x, y] = ring[0];

    return Math.abs(
      ring.slice(1).reduce((sum, [bx, by], i) => {
        const [ax, ay] = ring[i];

        return sum + (ax - x) * (by - y) - (bx - x) * (ay - y);
      }, 0),
    );
  }

  function prepare(item) {
    if (cache.has(item)) return cache.get(item);

    try {
      const box = [Infinity, Infinity, -Infinity, -Infinity];

      const rings = parseApiCoords(item.c).map((points) => {
        const ring = points.map(([lat, lng]) => {
          box[0] = Math.min(box[0], lng);
          box[1] = Math.min(box[1], lat);
          box[2] = Math.max(box[2], lng);
          box[3] = Math.max(box[3], lat);

          return [lng, lat];
        });

        const first = ring[0],
          last = ring[ring.length - 1];

        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);

        return ring;
      });

      if (!rings.length) return null;

      // Larger rings come first: each ring is either a shell or a hole in one.
      // API rings are valid and do not cross; nested islands are not inferred.
      const entries = rings.map((ring) => ({ ring, area: area(ring) }));
      entries.sort((a, b) => b.area - a.area);
      const polygons = [];

      for (const { ring } of entries) {
        const polygon = polygons.find(([shell]) => inside(ring[0], shell));

        if (polygon) polygon.push(ring);
        else polygons.push([ring]);
      }

      const result = { polygons, rings, box, tree: null };
      cache.set(item, result);

      return result;
    } catch {
      cache.set(item, null);

      return null;
    }
  }

  function toGeoJSON(item) {
    const prepared = prepare(item);

    if (!prepared) return null;
    const { polygons } = prepared;

    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }

  global.ZaliczGmineCommunesGeometry = { prepare, toGeoJSON };
})(globalThis);
