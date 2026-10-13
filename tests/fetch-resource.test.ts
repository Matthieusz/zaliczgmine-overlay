import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchRequest, fetchResource, handleFetch } from "../src/fetch-resource.ts";

const request = FetchRequest.make({
  type: "ZALICZGMINE_FETCH",
  url: "https://tickmyride.com/api/usersearch?q=test",
});

describe("background fetch boundary", () => {
  test("returns JSON through the existing runtime contract", async () => {
    const reply = await Effect.runPromise(
      handleFetch(request, async () => Response.json({ status: "success", items: [] })),
    );

    expect(reply).toEqual({ success: true, data: { status: "success", items: [] } });
  });

  test("keeps text responses intact", async () => {
    expect(
      await Effect.runPromise(
        handleFetch({ ...request, responseType: "text" }, async () => new Response("<gpx/>")),
      ),
    ).toEqual({ success: true, data: "<gpx/>" });
  });

  test("preserves provider code and HTTP status without serializing causes", async () => {
    expect(
      await Effect.runPromise(
        handleFetch(request, async () =>
          Response.json({ message: "User not found", code: "USER_NOT_FOUND" }, { status: 404 }),
        ),
      ),
    ).toEqual({ success: false, error: "User not found", code: "USER_NOT_FOUND", http: 404 });
  });

  test("reports a non-JSON HTTP error as HTTP failure", async () => {
    expect(
      await Effect.runPromise(
        handleFetch(request, async () => new Response("upstream down", { status: 503 })),
      ),
    ).toEqual({ success: false, error: "HTTP 503", http: 503 });
  });

  test("does not leak network error contents", async () => {
    const reply = await Effect.runPromise(
      handleFetch(request, async () => {
        throw new Error("private upstream details");
      }),
    );

    expect(reply).toEqual({ success: false, error: "Could not fetch data" });
  });

  test("closes the request's abort scope after reading the body", async () => {
    let requestSignal: AbortSignal | undefined;

    const result = await Effect.runPromise(
      fetchResource({ ...request, type: "ZALICZGMINE_FETCH" }, async (_url, signal) => {
        requestSignal = signal;
        expect(signal.aborted).toBe(false);

        return Response.json({ ok: true });
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(requestSignal?.aborted).toBe(true);
  });
});
