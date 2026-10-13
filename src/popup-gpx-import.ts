import { Effect, Schema } from "effect";
import { ChromeStorage } from "./chrome-storage.ts";
import { ChromeTabs } from "./chrome-tabs.ts";
import { remoteErrorMessageKey } from "./user-errors.ts";

const Track = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  text: Schema.String,
});

const Reply = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
});

/** Expected file-selection, file-reading, or planner rejection, expressed as a localization key. */
export class GpxImportError extends Schema.TaggedError<GpxImportError>()("GpxImportError", {
  key: Schema.String,
}) {}

/** Reads a selected file lazily; interruption detaches handlers and aborts an active reader. */
export const readGpxFile = Effect.fn("Popup.readGpxFile")(function* (
  file: File | undefined,
  createReader: () => FileReader = () => new FileReader(),
) {
  if (!file) return yield* new GpxImportError({ key: "gpx.chooseFile" });

  return yield* Effect.callback<string, GpxImportError>((resume) => {
    const reader = createReader();
    reader.onload = () => resume(Effect.succeed(String(reader.result || "")));
    reader.onerror = () => resume(Effect.fail(new GpxImportError({ key: "gpx.readError" })));
    reader.onabort = () => resume(Effect.fail(new GpxImportError({ key: "gpx.readError" })));

    try {
      reader.readAsText(file);
    } catch {
      resume(Effect.fail(new GpxImportError({ key: "gpx.readError" })));
    }

    return Effect.sync(() => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;

      if (reader.readyState === 1) reader.abort();
    });
  });
});

/** Saves before sending IMPORT_GPX; only explicit planner rejection rolls back. Legacy storage errors do not gate commands. */
export const importPopupGpx = Effect.fn("Popup.importGpx")(function* (
  file: File | undefined,
  action: string,
  createId: () => string,
  render: (tracks: ReadonlyArray<typeof Track.Type>) => void,
  createReader?: () => FileReader,
) {
  const text = yield* readGpxFile(file, createReader);
  const gpx = { id: createId(), name: file?.name || "track.gpx", text };
  const storage = yield* ChromeStorage;
  const tabs = yield* ChromeTabs;

  const stored = yield* storage
    .get(["zaliczGmineGpxList"])
    .pipe(Effect.orElseSucceed(() => ({ zaliczGmineGpxList: undefined })));

  const tracks = yield* Schema.decodeUnknownEffect(Schema.Array(Track))(
    stored.zaliczGmineGpxList,
  ).pipe(Effect.orElseSucceed(() => []));

  const nextTracks = [...tracks, gpx];

  const save = Effect.fn("Popup.saveGpx")(function* (values: ReadonlyArray<typeof Track.Type>) {
    yield* storage.set({ zaliczGmineGpxList: values }).pipe(Effect.orElseSucceed(() => undefined));
    yield* Effect.sync(() => render(values));
  });

  yield* save(nextTracks);

  const response = yield* tabs.sendCommand({ action, data: gpx }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Reply)),
    Effect.orElseSucceed((): typeof Reply.Type => ({})),
  );

  if (response.success) return "gpx.added";

  if (response.error && response.error !== "extension.noResponse") {
    yield* save(nextTracks.filter((track) => track.id !== gpx.id));

    return yield* new GpxImportError({ key: remoteErrorMessageKey(response.error) });
  }

  return "gpx.saved";
});
