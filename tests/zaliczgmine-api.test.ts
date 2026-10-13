import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ApiError, InvalidApiData } from "../src/user-errors.ts";
import { createApi } from "../src/zaliczgmine-api.ts";

const apiFor = <Input>(data: Input) => createApi("https://example.test/", async () => data);

test("decodes records for each endpoint", async () => {
  expect(
    await Effect.runPromise(
      apiFor({ status: "success", items: [{ id: 1, username: "rider" }] }).searchUsers("rider"),
    ),
  ).toEqual([{ id: 1, username: "rider" }]);
  expect(
    await Effect.runPromise(
      apiFor({ status: "success", items: [{ id: "1" }], count: 1, user: null }).getVisitedCommunes(
        "1",
        "pl",
      ),
    ),
  ).toEqual({ status: "success", items: [{ id: "1" }], count: 1, user: null });
  expect(
    await Effect.runPromise(
      apiFor({ status: "success", items: [{ i: "1", n: "Commune", c: "[]" }] }).getPolygons(
        9,
        "pl",
      ),
    ),
  ).toEqual([{ i: "1", n: "Commune", c: "[]" }]);
});

test("rejects malformed endpoint records and visited metadata", async () => {
  const malformed = apiFor({ status: "success", items: [{}], count: "1" });

  for (const operation of [
    malformed.searchUsers("rider").pipe(Effect.asVoid),
    malformed.getVisitedCommunes("1", "pl").pipe(Effect.asVoid),
    malformed.getPolygons(9, "pl").pipe(Effect.asVoid),
  ]) {
    await expect(Effect.runPromise(operation)).rejects.toMatchObject(new InvalidApiData({}));
  }
});

test("preserves provider failures and polygon bounds parameters", async () => {
  await expect(
    Effect.runPromise(apiFor({ status: "error", code: "USER_NOT_FOUND" }).searchUsers("missing")),
  ).rejects.toMatchObject(new ApiError({ reason: "userNotFound" }));
  const bounds = { north: 52, east: 21, south: 51, west: 20 };
  let requested = "";

  const api = createApi("https://example.test/", async (url) => {
    requested = url;

    return { status: "success", items: [] };
  });

  await Effect.runPromise(api.getPolygons(12, "pl", bounds));
  expect(new URL(requested).searchParams.get("bounds")).toBe(JSON.stringify(bounds));
});
