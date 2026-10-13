import { failureReply, remoteErrorMessageKey } from "../src/user-errors.ts";

document.addEventListener("DOMContentLoaded", async function () {
  const i18n = globalThis.ZaliczGmineI18n;
  const settings = await chrome.storage.local.get("language");
  i18n.setLanguage(settings.language);
  localize();
  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("popup");
  const { ACTION } = globalThis.ZaliczGmineMessageProtocol;
  const api = globalThis.createZaliczGmineApi();
  const visitedCommunesCountEl = document.getElementById("visitedCommunesCount");
  const toggleBtn = document.getElementById("toggleBtn");
  const selectedUserEl = document.getElementById("selectedUser");
  const userIdInput = document.getElementById("userIdInput");
  const saveUserIdBtn = document.getElementById("saveUserIdBtn");
  const gpxFileInput = document.getElementById("gpxFileInput");
  const chooseGpxBtn = document.getElementById("chooseGpxBtn");
  const importGpxBtn = document.getElementById("importGpxBtn");
  const removeAllGpxBtn = document.getElementById("removeAllGpxBtn");
  const gpxFileName = document.getElementById("gpxFileName");
  const gpxList = document.getElementById("gpxList");
  const gpxStatusText = document.getElementById("gpxStatusText");
  const mapStatusDot = document.getElementById("mapStatusDot");
  const plannerLinks = document.getElementById("plannerLinks");
  const mapStatusText = document.getElementById("mapStatusText");
  const statusDiv = document.getElementById("status");

  const languageSelect = document.getElementById("languageSelect");
  languageSelect.value = Object.hasOwn(i18n.messages, settings.language)
    ? settings.language
    : "auto";
  languageSelect.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({ language: languageSelect.value });
      document.getElementById("languageReloadHint").hidden = false;
    } catch {
      showStatus(t("language.saveError"), "error");
    }
  });

  function localize() {
    document.documentElement.lang = i18n.language;
    document.title = i18n.t("app.title");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = i18n.t(el.dataset.i18n);
    });

    for (const attr of ["placeholder", "aria-label", "alt"]) {
      document.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, i18n.t(el.getAttribute(`data-i18n-${attr}`)));
      });
    }

    document.querySelector(".header-title").textContent = i18n.brand();
    document.querySelector(".logo").alt = i18n.brand();
    document.querySelector(".logo").src =
      i18n.language === "pl" ? "../assets/zaliczgmine-badge.png" : "../assets/icons/icon16.svg";
    document.querySelector('#plannerLinks a[href*="veloplanner"]').href =
      `https://veloplanner.com/${i18n.language}/plan`;
  }

  init();

  async function init() {
    loadSelectedUser();
    loadGpxInfo();
    checkMapStatus();
  }

  function renderSelectedUser(userId, username) {
    selectedUserEl.textContent = userId
      ? t("account.selected", {
          username: username || t("account.userIdFallback", { id: userId }),
          id: userId,
        })
      : t("account.noneSelected");
    selectedUserEl.title = userId ? t("account.userIdTitle", { id: userId }) : "";
  }

  function loadSelectedUser() {
    chrome.storage.local.get(["zaliczGmineUserId", "zaliczGmineUsername"], function (result) {
      renderSelectedUser(result.zaliczGmineUserId, result.zaliczGmineUsername);
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName === "local" && (changes.zaliczGmineUserId || changes.zaliczGmineUsername)) {
      loadSelectedUser();
    }
  }

  chrome.storage.onChanged.addListener(handleStorageChange);
  window.addEventListener("unload", () =>
    chrome.storage.onChanged.removeListener(handleStorageChange),
  );

  function loadGpxInfo() {
    chrome.storage.local.get(["zaliczGmineGpxList"], function (result) {
      const tracks = normalizeStoredGpx(result);
      renderGpxList(tracks);
    });
  }

  function normalizeStoredGpx(result) {
    if (Array.isArray(result.zaliczGmineGpxList)) {
      return result.zaliczGmineGpxList;
    }

    return [];
  }

  function createGpxId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function getStoredGpxTracks(callback) {
    chrome.storage.local.get(["zaliczGmineGpxList"], function (result) {
      callback(normalizeStoredGpx(result));
    });
  }

  function setStoredGpxTracks(tracks, callback) {
    chrome.storage.local.set({ zaliczGmineGpxList: tracks }, function () {
      renderGpxList(tracks);

      if (callback) callback();
    });
  }

  function renderGpxList(tracks) {
    gpxList.textContent = "";

    if (!tracks.length) {
      gpxStatusText.textContent = t("gpx.emptyHint");

      return;
    }

    for (const track of tracks) {
      const item = document.createElement("div");
      item.className = "gpx-item";

      const name = document.createElement("div");
      name.className = "gpx-item-name";
      name.textContent = track.name || "track.gpx";

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "btn btn-danger gpx-item-remove";
      removeButton.textContent = t("gpx.remove");
      removeButton.addEventListener("click", function () {
        removeGpxTrack(track.id);
      });

      item.appendChild(name);
      item.appendChild(removeButton);
      gpxList.appendChild(item);
    }

    gpxStatusText.textContent = t("gpx.savedCount", { count: tracks.length });
  }

  function readSelectedGpx(callback) {
    const file = gpxFileInput.files && gpxFileInput.files[0];

    if (!file) {
      callback(null, t("gpx.chooseFile"));

      return;
    }

    const reader = new FileReader();
    reader.onload = function () {
      callback({
        id: createGpxId(),
        name: file.name,
        text: String(reader.result || ""),
      });
    };

    reader.onerror = function () {
      callback(null, t("gpx.readError"));
    };

    reader.readAsText(file);
  }

  chooseGpxBtn.addEventListener("click", function () {
    gpxFileInput.click();
  });

  gpxFileInput.addEventListener("change", function () {
    const file = gpxFileInput.files && gpxFileInput.files[0];
    gpxFileName.textContent = file ? file.name : t("gpx.noFile");
  });

  importGpxBtn.addEventListener("click", function () {
    readSelectedGpx(function (gpx, error) {
      if (error) {
        showStatus(error, "error");

        return;
      }

      getStoredGpxTracks(function (tracks) {
        const nextTracks = tracks.concat(gpx);

        setStoredGpxTracks(nextTracks, function () {
          sendMessageToContentScript(
            {
              action: ACTION.IMPORT_GPX,
              data: gpx,
            },
            function (response) {
              if (response && response.success) {
                gpxFileName.textContent = t("gpx.noFile");
                gpxFileInput.value = "";
                showStatus(t("gpx.added"), "success");
              } else if (response && response.error) {
                if (response.error === "extension.noResponse") {
                  showStatus(t("gpx.saved"), "success");
                } else {
                  setStoredGpxTracks(nextTracks.filter((track) => track.id !== gpx.id));
                  showStatus(t(remoteErrorMessageKey(response.error)), "error");
                }
              } else {
                showStatus(t("gpx.saved"), "success");
              }
            },
          );
        });
      });
    });
  });

  function removeGpxTrack(id) {
    getStoredGpxTracks(function (tracks) {
      const nextTracks = tracks.filter((track) => track.id !== id);

      setStoredGpxTracks(nextTracks, function () {
        sendMessageToContentScript(
          {
            action: ACTION.REMOVE_GPX,
            data: { id: id },
          },
          function (response) {
            if (response && response.success) {
              showStatus(t("gpx.removedFromMap"), "success");
            } else {
              showStatus(t("gpx.removedFromStorage"), "success");
            }
          },
        );
      });
    });
  }

  removeAllGpxBtn.addEventListener("click", function () {
    chrome.storage.local.remove(["zaliczGmineGpxList"], function () {
      gpxFileInput.value = "";
      gpxFileName.textContent = t("gpx.noFile");
      renderGpxList([]);

      sendMessageToContentScript({ action: ACTION.REMOVE_GPX }, function (response) {
        if (response && response.success) {
          showStatus(t("gpx.removedFromMap"), "success");
        } else {
          showStatus(t("gpx.removedFromStorage"), "success");
        }
      });
    });
  });

  const userSearchResults = document.getElementById("userSearchResults");
  let searchVersion = 0;

  userIdInput.addEventListener("input", function () {
    searchVersion++;
    userSearchResults.textContent = "";
  });
  userIdInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") saveUserIdBtn.click();
  });

  saveUserIdBtn.addEventListener("click", async function () {
    const query = userIdInput.value.trim();
    const version = ++searchVersion;
    userSearchResults.textContent = "";

    if (!query) {
      showStatus(t("account.queryRequired"), "error");

      return;
    }

    showStatus(t("account.searching"), "info");

    try {
      const users = await api.searchUsers(query);

      if (version !== searchVersion) return;

      if (!users.length) {
        showStatus(t("account.noResults"), "info");

        return;
      }

      showStatus(t("account.selectResult"), "info");

      for (const user of users) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary";
        button.style.whiteSpace = "normal";
        button.textContent = `${user.username} (ID: ${user.id})`;
        button.addEventListener("click", () => saveUser(user));
        userSearchResults.appendChild(button);
      }
    } catch (error) {
      if (version !== searchVersion) return;
      showStatus(t(failureReply(error).error), "error");
    }
  });

  function saveUser(user) {
    const userId = String(user.id);
    searchVersion++;
    userSearchResults.textContent = "";
    chrome.storage.local.set(
      { zaliczGmineUserId: userId, zaliczGmineUsername: user.username },
      function () {
        if (chrome.runtime.lastError) {
          showStatus(t("account.saveError"), "error");

          return;
        }

        renderSelectedUser(userId, user.username);
        userIdInput.value = "";
        showStatus(t("account.saved", { username: user.username }), "success");
        sendMessageToContentScript(
          {
            action: ACTION.RELOAD_COMMUNES,
            data: { userId },
          },
          function (response) {
            if (response?.success) {
              visitedCommunesCountEl.textContent = response.visitedCommunesCount;
              showStatus(
                t("communes.loadedCount", { count: response.visitedCommunesCount }),
                "success",
              );
            } else if (response?.error) {
              showStatus(t(remoteErrorMessageKey(response.error)), "error");
            } else {
              showStatus(t("account.savedOpenMap", { username: user.username }), "success");
            }
          },
        );
      },
    );
  }

  function updateVisibilityButton(visible) {
    toggleBtn.textContent = visible ? t("communes.hide") : t("communes.show");
  }

  toggleBtn.addEventListener("click", function () {
    sendMessageToContentScript({ action: ACTION.TOGGLE_COMMUNES }, function (response) {
      if (response && response.success) {
        updateVisibilityButton(response.visible);
        showStatus(t(response.visible ? "communes.nowVisible" : "communes.nowHidden"), "success");
      } else if (response && response.error) {
        showStatus(t(remoteErrorMessageKey(response.error)), "error");
      } else {
        showStatus(t("map.connectionError"), "error");
      }
    });
  });

  function checkMapStatus() {
    sendMessageToContentScript({ action: ACTION.GET_STATUS }, function (response) {
      plannerLinks.hidden = Boolean(response && response.connected);

      if (response && response.connected) {
        mapStatusDot.classList.add("connected");
        mapStatusDot.classList.remove("disconnected");
        mapStatusText.textContent = t("map.connected");
        updateVisibilityButton(response.visible);

        if (response.visitedCommunesCount !== undefined) {
          visitedCommunesCountEl.textContent = response.visitedCommunesCount;
        }

        if (Array.isArray(response.gpxTracks)) {
          getStoredGpxTracks(function (tracks) {
            renderGpxList(tracks.length ? tracks : response.gpxTracks);
          });
        }
      } else {
        mapStatusDot.classList.add("disconnected");
        mapStatusDot.classList.remove("connected");
        mapStatusText.textContent = t("map.disconnected");
        visitedCommunesCountEl.textContent = "-";

        // loadVisitedCommunesCountFromStorage();
      }
    });
  }

  // function loadVisitedCommunesCountFromStorage() {
  //   chrome.storage.local.get(['visitedCommunesCount'], function(result) {
  //     if (result.visitedCommunesCount) {
  //       visitedCommunesCountEl.textContent = result.visitedCommunesCount;
  //     }
  //   });
  // }

  function sendMessageToContentScript(message, callback) {
    log.debug("Sending command", { action: message.action });
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message, function (response) {
          if (chrome.runtime.lastError) {
            log.warn("Tab did not respond", chrome.runtime.lastError);

            if (callback) callback(null);
          } else {
            log.debug("Command response", {
              action: message.action,
              success: response?.success,
              connected: response?.connected,
            });

            if (callback) callback(response);
          }
        });
      } else {
        if (callback) callback(null);
      }
    });
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = "status " + type;
    statusDiv.style.display = "block";

    setTimeout(function () {
      statusDiv.style.display = "none";
    }, 5000);
  }
});
