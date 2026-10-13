import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { apiFailure, failureReply, NetworkError, InvalidApiData } from "../src/user-errors.ts";
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

  test("maps provider codes and HTTP status without serializing provider text", async () => {
    expect(
      await Effect.runPromise(
        handleFetch(request, async () =>
          Response.json(
            { message: "private provider details", code: "USER_NOT_FOUND" },
            { status: 404 },
          ),
        ),
      ),
    ).toEqual(failureReply(apiFailure("USER_NOT_FOUND", 404)));
  });

  test("reports a non-JSON HTTP error as HTTP failure", async () => {
    expect(
      await Effect.runPromise(
        handleFetch(request, async () => new Response("upstream down", { status: 503 })),
      ),
    ).toEqual(failureReply(apiFailure(undefined, 503)));
  });

  test("does not leak network error contents", async () => {
    const reply = await Effect.runPromise(
      handleFetch(request, async () => {
        throw new TypeError("private upstream details");
      }),
    );

    expect(reply).toEqual(failureReply(new NetworkError({ reason: "unavailable" })));
  });

  test("invalid JSON is an expected data failure", async () => {
    expect(
      await Effect.runPromise(
        handleFetch(request, async () => new Response("private invalid JSON")),
      ),
    ).toEqual(failureReply(new InvalidApiData({})));
  });

  test("unexpected transport exceptions remain defects", async () => {
    const exit = await Effect.runPromiseExit(
      handleFetch(request, async () => {
        throw new Error("private defect");
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
    }
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
