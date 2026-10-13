/*!
 * intersects, inRing and contains adapted from Turf.js v6.5.0 (MIT).
 * Copyright (c) 2019 Morgan Herlocker. See THIRD_PARTY_LICENSES.txt.
 */
(function (global) {
  "use strict";

  const EPSILON = 1e-12;

  const overlaps = (a, b) =>
    a[0] <= b[2] + EPSILON &&
    a[2] + EPSILON >= b[0] &&
    a[1] <= b[3] + EPSILON &&
    a[3] + EPSILON >= b[1];

  const bounds = (a, b) => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];

  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  const onSegment = (p, a, b) =>
    Math.abs(cross(a, b, p)) <= EPSILON && overlaps(bounds(p, p), bounds(a, b));

  // Turf line-intersect's two-segment predicate, returning only a boolean.
  function intersects(a, b, c, d) {
    // Turf returns null for collinear segments. For commune boundaries these
    // overlaps (and degenerate segments) must count, with our existing tolerance.
    if (onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d))
      return true;

    const [x1, y1] = a,
      [x2, y2] = b,
      [x3, y3] = c,
      [x4, y4] = d;

    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    const numeA = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
    const numeB = (x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3);

    if (denom === 0) return false;
    const uA = numeA / denom;
    const uB = numeB / denom;

    return uA >= 0 && uA <= 1 && uB >= 0 && uB <= 1;
  }

  // A linear-time bounding-volume tree preserves the locality of consecutive
  // route/ring segments. No sorting or external spatial-index dependency needed.
  function* buildTree(segments) {
    let level = segments;

    while (level.length > 1) {
      const next = [];

      for (let i = 0; i < level.length; i += 8) {
        const children = level.slice(i, i + 8);
        const box = [Infinity, Infinity, -Infinity, -Infinity];

        for (const child of children) {
          box[0] = Math.min(box[0], child.box[0]);
          box[1] = Math.min(box[1], child.box[1]);
          box[2] = Math.max(box[2], child.box[2]);
          box[3] = Math.max(box[3], child.box[3]);
        }

        next.push({ box, children });
        yield;
      }

      level = next;
    }

    return level[0] || null;
  }

  // Turf's inRing, with cooperative iteration.
  function* inRing(pt, ring, ignoreBoundary = false) {
    let isInside = false;
    let length = ring.length;

    if (ring[0][0] === ring[length - 1][0] && ring[0][1] === ring[length - 1][1]) length--;

    for (let i = 0, j = length - 1; i < length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];

      // Use the application's tolerance instead of Turf's exact boundary test.
      if (onSegment(pt, ring[j], ring[i])) return !ignoreBoundary;

      const intersect =
        yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;

      if (intersect) isInside = !isInside;
      yield;
    }

    return isInside;
  }

  // Turf's Polygon containment: include the outer boundary, exclude hole
  // interiors only, so touching a hole boundary still counts as a match.
  function* containsPolygon(point, rings) {
    if (!(yield* inRing(point, rings[0]))) return false;

    for (let k = 1; k < rings.length; k++) {
      if (yield* inRing(point, rings[k], true)) return false;
    }

    return true;
  }

  function* contains(point, polygons) {
    for (const rings of polygons) {
      if (yield* containsPolygon(point, rings)) return true;
    }

    return false;
  }

  function* treesIntersect(route, polygon) {
    const stack = [[route, polygon]];

    while (stack.length) {
      const [a, b] = stack.pop();
      yield;

      if (!a || !b || !overlaps(a.box, b.box)) continue;

      if (a.children) {
        for (const child of a.children) stack.push([child, b]);
      } else if (b.children) {
        for (const child of b.children) stack.push([a, child]);
      } else if (intersects(a.a, a.b, b.a, b.b)) return true;
    }

    return false;
  }

  function* findMatches(lines, polygons) {
    const segments = [];

    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        segments.push({ a: line[i - 1], b: line[i], box: bounds(line[i - 1], line[i]) });
        yield;
      }
    }

    const route = yield* buildTree(segments);
    const matches = [];

    if (!route) return matches;

    for (const item of polygons) {
      yield;
      const polygon = global.ZaliczGmineCommunesGeometry.prepare(item);

      if (!polygon || !overlaps(route.box, polygon.box)) continue;
      let hit = false;

      for (const line of lines) {
        if (
          overlaps(bounds(line[0], line[0]), polygon.box) &&
          (yield* contains(line[0], polygon.polygons))
        ) {
          hit = true;
          break;
        }
      }

      if (!hit) {
        // Build the edge index only for nearby polygons whose containment test
        // did not already succeed. Distant communes never need an edge tree.
        if (!polygon.tree) {
          const edges = [];

          for (const ring of polygon.rings) {
            for (let i = 0; i < ring.length; i++) {
              const a = ring[i],
                b = ring[(i + 1) % ring.length];

              edges.push({ a, b, box: bounds(a, b) });
              yield;
            }
          }

          polygon.tree = yield* buildTree(edges);
        }

        hit = yield* treesIntersect(route, polygon.tree);
      }

      if (hit) matches.push(item);
    }

    return matches;
  }

  // Route checks yield between steps; commune preparation is synchronous.
  async function calculate(lines, polygons, cancelled = () => false) {
    const job = findMatches(lines, polygons);
    let deadline = performance.now() + 6;

    for (let steps = 0; ; steps++) {
      if (cancelled()) return null;
      const result = job.next();

      if (result.done) return result.value;

      if (steps % 128 === 0 && performance.now() >= deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        deadline = performance.now() + 6;
      }
    }
  }

  global.ZaliczGmineRouteGeometry = { calculate };
})(globalThis);
