import { Effect, Option, Schema } from "effect";
import { FetchRequest, handleFetch } from "./fetch-resource.ts";
import { apiFailure, failureReply } from "./user-errors.ts";

const FetchMessage = Schema.Struct({ type: FetchRequest.fields.type });

// Chrome owns each request lifetime via return true; the effect is bounded to 30 seconds.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (Option.isNone(Schema.decodeUnknownOption(FetchMessage)(message))) return false;

  const request = Schema.decodeUnknownOption(FetchRequest)(message);

  if (Option.isNone(request)) {
    sendResponse(failureReply(apiFailure("INVALID_REQUEST")));

    return false;
  }

  Effect.runFork(
    handleFetch(request.value, (url, signal) => fetch(url, { signal })).pipe(
      Effect.tap((reply) => Effect.sync(() => sendResponse(reply))),
      Effect.tapDefect(() => Effect.sync(() => sendResponse(failureReply(undefined)))),
    ),
  );

  return true;
});
