/* Classic scripts deliberately share the legacy bundle's global exports. */
importScripts("ext/sjcl.js", "global.min.js");

(() => {
  const menuId = "onepassword";
  const reconnectAlarm = "onepassword-reconnect";
  const statePrefix = "mv3.goAndFill.";
  const pauseKey = "mv3.desktopPaused";
  const pendingLifetime = 2 * 60 * 1000;
  const pending = new Map();
  const op = globalThis.OnePassword;
  let desktopPaused = false;
  let writes = Promise.resolve();

  function report(error) {
    console.error("[1Password MV3]", error);
  }

  // Serialize changes so a completed/cleared operation cannot be resurrected by
  // an earlier storage write. Only navigation metadata is stored, not logins.
  function persist(tabId, record) {
    const key = statePrefix + tabId;
    const snapshot = record && JSON.parse(JSON.stringify(record));
    writes = writes.then(() => snapshot
      ? chrome.storage.session.set({ [key]: snapshot })
      : chrome.storage.session.remove(key)).catch(report);
    return writes;
  }

  const track = op.trackGoAndFillOperationForTabReference;
  const clear = op.clearGoAndFillForTab;
  op.trackGoAndFillOperationForTabReference = op.kb = function (operation, tabId) {
    clear.call(op, tabId);
    track.call(op, operation, tabId);
    if (Number.isInteger(tabId) && tabId >= 0) {
      const record = { operation, createdAt: Date.now(), notifyOnLoad: false };
      pending.set(tabId, record);
      persist(tabId, record);
    }
  };
  op.clearGoAndFillForTab = op.ta = function (tabId) {
    clear.call(op, tabId);
    if (Number.isInteger(tabId) && tabId >= 0) {
      pending.delete(tabId);
      persist(tabId, null);
    }
  };

  async function restoreState() {
    const state = await chrome.storage.session.get(null);
    desktopPaused = state[pauseKey] === true;
    for (const [key, record] of Object.entries(state)) {
      if (!key.startsWith(statePrefix)) continue;
      const tabId = Number(key.slice(statePrefix.length));
      if (!Number.isInteger(tabId) || !record?.operation ||
          Date.now() - record.createdAt > pendingLifetime) {
        await chrome.storage.session.remove(key);
        continue;
      }
      try {
        await chrome.tabs.get(tabId);
        track.call(op, record.operation, tabId);
        pending.set(tabId, record);
      } catch {
        await chrome.storage.session.remove(key);
      }
    }
  }

  op.setToolbarButtonEnabled = function (enabled) {
    op.toolbarButtonEnabled = enabled;
    (enabled ? chrome.action.enable() : chrome.action.disable()).catch(report);
  };
  op.lastWindow = Date.now();
  op.setToolbarButtonEnabled(true);

  // The original native transport still handles authentication, encryption,
  // reconnect delays, and the legacy localhost WebSocket fallback. A one-shot
  // alarm revives a worker if a disconnected transport's retry timer is lost.
  globalThis.mv3ScheduleReconnect = function () {
    if (!desktopPaused) {
      chrome.alarms.create(reconnectAlarm, { delayInMinutes: 1 }).catch(report);
    }
  };
  Agent.connect = function (force = false) {
    if (desktopPaused || this.c?.mv3Connecting) return;
    if (this.isConnected()) {
      if (!force) return;
      // The authenticator calls connect(true) after clearing credentials.
      // Close the old transport before Xc creates one with fresh auth state.
      this.c.disconnect({});
    }
    Xc(this).then(connection => {
      console.info("[1Password MV3] Connected to desktop app: " + connection);
    }, report);
  };
  const pause = Agent.pause;
  Agent.pause = function (duration) {
    if (duration === Infinity) {
      desktopPaused = true;
      chrome.storage.session.set({ [pauseKey]: true }).catch(report);
      chrome.alarms.clear(reconnectAlarm).catch(report);
    }
    return pause.call(this, duration);
  };

  function flushBookmarks() {
    if (!Agent.c || !Agent.c.da("loginBookmarkLoaded")) return;
    for (const [tabId, record] of pending) {
      if (Date.now() - record.createdAt > pendingLifetime) {
        op.clearGoAndFillForTab(tabId);
      } else if (record.notifyOnLoad && record.completed) {
        record.notifyOnLoad = false;
        persist(tabId, record);
        Agent.sendLoginBookmarkLoaded(record.operation.itemUUID, record.operation.vaultUUID);
      }
    }
  }
  Agent.on("ConnectionDidEstablishConnection", () => {
    chrome.alarms.clear(reconnectAlarm).catch(report);
    // The bundle marks its port ready after delivering this event.
    queueMicrotask(flushBookmarks);
  });

  const ready = restoreState().then(() => {
    Agent.connect();
  });
  ready.catch(report);

  async function openPopup(source, url) {
    await ready;
    if (desktopPaused) {
      desktopPaused = false;
      await chrome.storage.session.remove(pauseKey);
      op.setToolbarButtonEnabled(true);
    }
    if (!Agent.c) Agent.connect();
    if (url) op.showPopup(source, url);
    else F(activeURL => op.showPopup(source, activeURL));
  }

  function prepareBookmark(url, tabId) {
    const source = new URL(url);
    if (!["http:", "https:"].includes(source.protocol)) return;
    const bookmark = op.checkForGoAndFillBookmarkLoaded(source.href);
    if (!bookmark) return;
    op.trackGoAndFillOperationForTabReference({
      itemUUID: bookmark.uuid,
      vaultUUID: bookmark.vaultUUID,
      url: bookmark.url,
      nakedDomains: null,
      uuid: crypto.randomUUID(),
      context: null
    }, tabId);
    const record = pending.get(tabId);
    record.notifyOnLoad = true;
    record.completed = false;
    persist(tabId, record);
  }

  // Register Chrome listeners synchronously, before storage/connection setup.
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!sender.tab || sender.id !== chrome.runtime.id) return false;
    ready.then(() => {
      if (message?.command) {
        const result = performCommand(sender.tab, message.command, message.params,
          response => respond(response || {}));
        if (result === "Unknown") respond({});
      } else if (message?.name) {
        handleMessageEvent(sender.tab, message.name, message.message,
          response => respond(response || {}));
      } else {
        respond({});
      }
    }).catch(error => {
      report(error);
      respond({ error: error.message });
    });
    return true;
  });

  chrome.action.onClicked.addListener(tab => {
    openPopup("toolbar-button", tab?.url).catch(report);
  });
  chrome.contextMenus.onClicked.addListener(info => {
    if (info.menuItemId === menuId) openPopup("context-menu", info.pageUrl).catch(report);
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: menuId, title: "1Password", contexts: ["all"] }, () => {
        if (chrome.runtime.lastError) report(chrome.runtime.lastError.message);
      });
    });
  });
  chrome.runtime.onStartup.addListener(() => {
    ready.catch(report);
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === reconnectAlarm) {
      // A cold worker reconnects in `ready`; a live worker already has the
      // transport's retry timer. Do not open a competing connection here.
      ready.catch(report);
    }
  });
  chrome.windows.onFocusChanged.addListener(windowId => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.windows.get(windowId, { windowTypes: ["normal"] }, window => {
      if (chrome.runtime.lastError) return;
      if (window?.focused) op.lastWindow = Date.now();
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
    if (changes.status !== "complete") return;
    ready.then(() => {
      if (tab.url === "https://agilebits.com/browsers/welcome.html") op.welcomeScreenLoaded(tab);
      else if (tab.url === "https://agilebits.com/browsers/auth.html" && C) C.ub(tab);
    }).catch(report);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    ready.then(() => op.clearGoAndFillForTab(tabId)).catch(report);
  });
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return;
    // Capture the original URL before DNR removes the bookmark parameters.
    // Both navigation handlers wait on ready, so tracking precedes completion
    // even when this navigation wakes a cold worker. The redirect stays on
    // HTTP(S), allowing Go & Fill in spanning-mode incognito tabs as well.
    ready.then(() => prepareBookmark(details.url, details.tabId)).catch(report);
  }, { url: [{ schemes: ["http", "https"] }] });
  chrome.webNavigation.onDOMContentLoaded.addListener(details => {
    if (details.frameId !== 0) return;
    if (!["http:", "https:"].includes(new URL(details.url).protocol)) return;
    ready.then(() => {
      const record = pending.get(details.tabId);
      if (!record?.notifyOnLoad) return;
      record.completed = true;
      persist(details.tabId, record);
      flushBookmarks();
    }).catch(report);
  }, { url: [{ schemes: ["http", "https"] }] });
})();
