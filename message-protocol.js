(function (global) {
  "use strict";

  const MESSAGE = Object.freeze({
    // content-script.js -> background.js
    FETCH: "ZALICZGMINE_FETCH",

    // page <-> content-script.js
    FETCH_REQUEST: "ZALICZGMINE_FETCH_REQUEST",
    FETCH_RESPONSE: "ZALICZGMINE_FETCH_RESPONSE",

    STORAGE_GET: "ZALICZGMINE_STORAGE_GET",
    STORAGE_SET: "ZALICZGMINE_STORAGE_SET",
    STORAGE_RESPONSE: "ZALICZGMINE_STORAGE_RESPONSE",

    // popup.js <-> content-script.js <-> map-app.js
    COMMAND: "ZALICZGMINE_COMMAND",
    COMMAND_RESPONSE: "ZALICZGMINE_COMMAND_RESPONSE",
  });

  // command actions
  const ACTION = Object.freeze({
    GET_STATUS: "getStatus",
    TOGGLE_COMMUNES: "toggleCommunes",
    RELOAD_COMMUNES: "reloadVisitedCommunes",
    IMPORT_GPX: "importGpx",
    REMOVE_GPX: "removeGpx",
  });

  global.ZaliczGmineMessageProtocol = Object.freeze({
    MESSAGE,
    ACTION,
  });
})(globalThis);
