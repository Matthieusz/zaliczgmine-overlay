import { Effect, Option, Schema } from "effect";
import { InvalidApiData, UserError, apiFailure } from "./user-errors.ts";

const Id = Schema.Union([Schema.String, Schema.Int]);

const User = Schema.Struct({ id: Id, username: Schema.String });

const Commune = Schema.Struct({ id: Id });

const Polygon = Schema.Struct({ i: Id, n: Schema.String, c: Schema.String });

const SearchResponse = Schema.Struct({
  status: Schema.Literal("success"),
  items: Schema.Array(User),
});

const VisitedResponse = Schema.Struct({
  status: Schema.Literal("success"),
  items: Schema.Array(Commune),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  user: Schema.optionalKey(Schema.NullOr(User)),
});

const PolygonResponse = Schema.Struct({
  status: Schema.Literal("success"),
  items: Schema.Array(Polygon),
});

const Rejection = Schema.Struct({
  status: Schema.Literal("error"),
  code: Schema.optionalKey(Schema.Unknown),
});

/** Adapts promise ports: decoded expected failures stay typed, other exceptions remain defects. */
export const loadingStep = Effect.fn("Communes.loadingStep")(function* <A>(
  operation: () => Promise<A>,
) {
  return yield* Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      const parsed = Schema.decodeUnknownOption(UserError)(cause);

      if (Option.isSome(parsed)) return parsed.value;
      throw cause;
    },
  });
});

/** Creates endpoint-specific workflows over a JSON transport; no caller recovery is applied here. */
export function createApi<Input>(baseUrl: string, fetchResource: (url: string) => Promise<Input>) {
  const get = Effect.fn("ZaliczGmineApi.get")(function* <A, I>(
    endpoint: string,
    params: Record<string, string>,
    schema: Schema.Codec<A, I>,
  ) {
    const data = yield* loadingStep(() =>
      fetchResource(baseUrl + endpoint + "?" + new URLSearchParams(params)),
    );

    const rejection = Schema.decodeUnknownOption(Rejection)(data);

    if (Option.isSome(rejection)) return yield* Effect.fail(apiFailure(rejection.value.code));

    return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError(() => new InvalidApiData({})),
    );
  });

  return {
    searchUsers: Effect.fn("ZaliczGmineApi.searchUsers")(function* (query: string) {
      return (yield* get("usersearch", { q: query }, SearchResponse)).items;
    }),
    getVisitedCommunes: Effect.fn("ZaliczGmineApi.getVisitedCommunes")(function* (
      userId: string,
      country: string,
    ) {
      return yield* get("usercommunes", { user_id: userId, country }, VisitedResponse);
    }),
    getPolygons: Effect.fn("ZaliczGmineApi.getPolygons")(function* (
      zoom: number,
      country: string,
      bounds?: {
        readonly north: number;
        readonly east: number;
        readonly south: number;
        readonly west: number;
      },
    ) {
      const params = bounds
        ? { zoom: String(zoom), country, bounds: JSON.stringify(bounds) }
        : { zoom: String(zoom), country };

      return (yield* get("geompolygons", params, PolygonResponse)).items;
    }),
  };
}
