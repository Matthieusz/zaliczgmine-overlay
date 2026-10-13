import { Effect, Option, Result, Schema } from "effect";
import { InvalidGpx } from "./user-errors.ts";

const StoredTrack = Schema.Struct({
  text: Schema.String,
  name: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
});

/** Restores valid saved tracks sequentially; malformed records/GPX are skipped, defects propagate. */
export const restoreGpx = Effect.fn("Gpx.restore")(function* <Input, Summary>(
  input: Input,
  restore: (text: string, name: string | undefined, id: string | undefined) => Summary,
) {
  const records = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(input).pipe(
    Effect.orElseSucceed(() => []),
  );

  let skipped = 0;

  for (const record of records) {
    const parsed = yield* Effect.result(Schema.decodeUnknownEffect(StoredTrack)(record));

    if (Result.isFailure(parsed)) {
      skipped++;
      continue;
    }

    const track = parsed.success;

    const restored = yield* Effect.result(
      Effect.try({
        try: () => restore(track.text, track.name, track.id),
        catch: (cause) => {
          const error = Schema.decodeUnknownOption(InvalidGpx)(cause);

          if (Option.isSome(error)) return error.value;
          throw cause;
        },
      }),
    );

    if (Result.isFailure(restored)) skipped++;
  }

  return { skipped };
});
