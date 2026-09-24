/* Classic scripts deliberately share the legacy bundle's global exports. */
importScripts("ext/sjcl.js", "global.min.js");

(() => {
  const menuId = "onepassword";
  const reconnectAlarm = "onepassword-reconnect";
  const statePrefix = "mv3.goAndFill.";
  const pauseKey = "mv3.desktopPaused";
  const pendingLifetime = 2 * 60 * 1000;
  const pending = new Map();
  const navigationVersions = new Map();
  const documentTargets = new Map();
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
    if (snapshot) delete snapshot.checking;
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
      const record = { operation, createdAt: Date.now(), notifyOnLoad: false,
        navigationVersion: navigationVersions.get(tabId) || 0 };
      pending.set(tabId, record);
      persist(tabId, record);
      queueMicrotask(async () => {
        if (record.notifyOnLoad) return; // Bookmarks bind only through onCommitted.
        try {
          const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
          if (freshRecord(tabId) === record && !record.documentId &&
              record.navigationVersion === (navigationVersions.get(tabId) || 0) &&
              frame?.documentLifecycle === "active" && urlKey(frame.url) === urlKey(operation.url)) {
            record.documentId = frame.documentId;
            record.documentURL = urlKey(frame.url);
            persist(tabId, record);
          }
        } catch { /* A new tab may not have committed yet. */ }
      });
    }
  };
  op.clearGoAndFillForTab = op.ta = function (tabId) {
    clear.call(op, tabId);
    if (Number.isInteger(tabId) && tabId >= 0) {
      pending.delete(tabId);
      persist(tabId, null);
    }
  };

  function urlKey(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    // Match URLSearchParams normalization used by the legacy bookmark parser.
    url.search = url.searchParams.toString();
    return url.href;
  }

  function freshRecord(tabId) {
    const record = pending.get(tabId);
    if (record && (!Number.isFinite(record.createdAt) ||
        Date.now() < record.createdAt || Date.now() - record.createdAt >= pendingLifetime)) {
      op.clearGoAndFillForTab(tabId);
      return null;
    }
    return record;
  }

  function cancelNavigation(tabId) {
    navigationVersions.set(tabId, (navigationVersions.get(tabId) || 0) + 1);
    op.clearGoAndFillForTab(tabId);
    for (const [id, target] of documentTargets) {
      if (target.tabId === tabId) {
        documentTargets.delete(id);
        delete op.K[id];
      }
    }
  }

  async function currentDocument(tabId, record) {
    const [tab, frame] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.webNavigation.getFrame({ tabId, frameId: 0 })
    ]);
    return freshRecord(tabId) === record &&
      record.navigationVersion === (navigationVersions.get(tabId) || 0) &&
      !tab.pendingUrl && frame?.documentLifecycle === "active" && !frame.errorOccurred &&
      frame.documentId === record.documentId && urlKey(frame.url) === record.documentURL;
  }

  // Legacy lookups must not use expired operations even if no alarm/event ran.
  const lookup = op.goAndFillOperationForTabReference;
  op.goAndFillOperationForTabReference = op.Nb = function (tabId) {
    freshRecord(tabId);
    return lookup.call(op, tabId);
  };
  const findTab = op.tabReferenceForGoAndFillOperationPropertyValue;
  op.tabReferenceForGoAndFillOperationPropertyValue = op.jb = function (...args) {
    for (const tabId of pending.keys()) freshRecord(tabId);
    return findTab.apply(op, args);
  };

  async function restoreState() {
    const state = await chrome.storage.session.get(null);
    desktopPaused = state[pauseKey] === true;
    for (const [key, record] of Object.entries(state)) {
      if (!key.startsWith(statePrefix)) continue;
      const tabId = Number(key.slice(statePrefix.length));
      if (!Number.isInteger(tabId) || !record?.operation || !record.documentId ||
          !Number.isFinite(record.createdAt) || Date.now() < record.createdAt ||
          Date.now() - record.createdAt >= pendingLifetime || navigationVersions.has(tabId)) {
        await chrome.storage.session.remove(key);
        continue;
      }
      record.navigationVersion = 0;
      pending.set(tabId, record);
      try {
        if (!await currentDocument(tabId, record)) throw new Error("Abandoned navigation");
        track.call(op, record.operation, tabId);
      } catch {
        op.clearGoAndFillForTab(tabId);
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

  async function flushBookmarks() {
    for (const tabId of pending.keys()) {
      const record = freshRecord(tabId);
      if (!record?.notifyOnLoad || !record.completed || record.checking) continue;
      record.checking = true;
      try {
        if (!await currentDocument(tabId, record)) {
          if (pending.get(tabId) === record) op.clearGoAndFillForTab(tabId);
          continue;
        }
        if (!Agent.c?.da("loginBookmarkLoaded")) continue;
        record.notifyOnLoad = false;
        persist(tabId, record);
        Agent.sendLoginBookmarkLoaded(record.operation.itemUUID, record.operation.vaultUUID);
      } catch {
        if (pending.get(tabId) === record) op.clearGoAndFillForTab(tabId);
      } finally {
        record.checking = false;
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
    const version = navigationVersions.get(sender.tab.id) || 0;
    ready.then(async () => {
      if (version !== (navigationVersions.get(sender.tab.id) || 0)) return respond({});
      if (message?.command === "collectDocumentResults") {
        if (!sender.documentId || !sender.url || urlKey(sender.url) !== urlKey(message.params?.url)) {
          return respond({});
        }
        documentTargets.set(message.params.documentUUID, {
          tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId,
          url: urlKey(sender.url), version, createdAt: Date.now(),
          operationCreatedAt: freshRecord(sender.tab.id)?.createdAt
        });
      }
      if (message?.command === "checkForGoAndFill") {
        const record = freshRecord(sender.tab.id);
        if (record && !await currentDocument(sender.tab.id, record)) return respond({});
      }
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
    cancelNavigation(tabId);
    ready.then(() => op.clearGoAndFillForTab(tabId)).catch(report);
  });
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return;
    const previous = freshRecord(details.tabId);
    // A provisional repeat to the cleaned DNR destination is still the same
    // operation. Once committed, even a same-URL reload cancels it.
    const continuation = previous && !previous.documentId &&
      urlKey(details.url) === urlKey(previous.operation.url);
    if (!continuation) cancelNavigation(details.tabId);
    const version = navigationVersions.get(details.tabId) || 0;
    ready.then(() => {
      if (version !== (navigationVersions.get(details.tabId) || 0) || continuation) return;
      prepareBookmark(details.url, details.tabId);
    }).catch(report);
  });
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId !== 0) return;
    const version = navigationVersions.get(details.tabId) || 0;
    ready.then(() => {
      const record = freshRecord(details.tabId);
      if (!record || record.navigationVersion !== version ||
          version !== (navigationVersions.get(details.tabId) || 0)) return;
      const url = urlKey(details.url);
      if (record.documentId === details.documentId && record.documentURL === url) return;
      if (record.documentId || !details.documentId || !url ||
          details.documentLifecycle !== "active" ||
          (url !== urlKey(record.operation.url) &&
           !details.transitionQualifiers?.includes("server_redirect"))) {
        cancelNavigation(details.tabId);
        return;
      }
      record.documentId = details.documentId;
      record.documentURL = url;
      persist(details.tabId, record);
    }).catch(report);
  });
  const abandonNavigation = details => {
    if (details.frameId === 0) {
      cancelNavigation(details.tabId);
      ready.then(() => op.clearGoAndFillForTab(details.tabId)).catch(report);
    }
  };
  chrome.webNavigation.onErrorOccurred.addListener(abandonNavigation);
  chrome.webNavigation.onHistoryStateUpdated.addListener(abandonNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(abandonNavigation);
  chrome.webNavigation.onDOMContentLoaded.addListener(details => {
    if (details.frameId !== 0) return;
    ready.then(() => {
      const record = freshRecord(details.tabId);
      if (!record?.notifyOnLoad || record.documentId !== details.documentId ||
          record.documentURL !== urlKey(details.url)) return;
      record.completed = true;
      persist(details.tabId, record);
      flushBookmarks().catch(report);
    }).catch(report);
  });

  // Pin credential-bearing messages to the document that supplied the fields.
  // The legacy domain checks still run before this dispatch boundary.
  const send = z;
  z = function (tab, name, message) {
    if (!["executeFillScript", "legacy_executeFillScript"].includes(name)) {
      return send(tab, name, message);
    }
    const target = documentTargets.get(message?.documentUUID);
    if (!target) return;
    (async () => {
      const [currentTab, frame] = await Promise.all([
        chrome.tabs.get(target.tabId),
        chrome.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId })
      ]);
      if (documentTargets.get(message.documentUUID) !== target ||
          target.version !== (navigationVersions.get(target.tabId) || 0) ||
          Date.now() - target.createdAt >= pendingLifetime || currentTab.pendingUrl ||
          (target.operationCreatedAt !== undefined &&
           Date.now() - target.operationCreatedAt >= pendingLifetime) ||
          frame?.documentLifecycle !== "active" || frame.errorOccurred ||
          frame.documentId !== target.documentId || urlKey(frame.url) !== target.url) return;
      chrome.tabs.sendMessage(target.tabId, { name, message },
        { documentId: target.documentId }, () => { void chrome.runtime.lastError; });
    })().catch(() => {}); // Closed or replaced documents must not receive a fill.
  };
})();
