/* Classic scripts deliberately share the legacy bundle's global exports. */
importScripts("ext/sjcl.js", "global.min.js");

(() => {
  const menuId = "onepassword";
  const reconnectAlarm = "onepassword-reconnect";
  const expiryAlarm = "onepassword-pending-expiry";
  const statePrefix = "mv3.goAndFill.";
  const pauseKey = "mv3.desktopPaused";
  const pendingLifetime = 2 * 60 * 1000;
  const pending = new Map();
  const navigationVersions = new Map();
  const documentTargets = new Map();
  const op = globalThis.OnePassword;
  let desktopPaused = false;
  let writes = Promise.resolve();
  let expiryTimer;

  function report(error) {
    console.error("[1Password MV3]", error);
  }

  function expired(createdAt) {
    return !Number.isFinite(createdAt) || Date.now() < createdAt ||
      Date.now() - createdAt >= pendingLifetime;
  }

  async function fingerprint(url) {
    const bytes = new TextEncoder().encode(urlKey(url));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  // Resume only an unsent bookmark bound to a committed document. Never copy
  // URLs, fragments, userinfo, desktop contexts, or whole operation objects.
  // Serialize writes/removals so canceled state cannot be resurrected.
  function persist(tabId, record) {
    const key = statePrefix + tabId;
    const snapshot = record?.notifyOnLoad && record.documentId ? {
      schema: 2, createdAt: record.createdAt, itemUUID: record.operation.itemUUID,
      vaultUUID: record.operation.vaultUUID, documentId: record.documentId,
      completed: record.completed === true
    } : null;
    const url = snapshot ? record.documentURL : null;
    const valid = () => snapshot && pending.get(tabId) === record &&
      record.notifyOnLoad && !expired(snapshot.createdAt);
    writes = writes.then(async () => {
      if (!valid()) return chrome.storage.session.remove(key);
      snapshot.documentURLHash = await fingerprint(url);
      // Hashing/storage can be delayed, so check the deadline again before writing.
      if (!valid()) return chrome.storage.session.remove(key);
      await chrome.storage.session.set({ [key]: snapshot });
    }).catch(report);
    return writes;
  }

  function targetExpired(target) {
    return expired(target.createdAt) ||
      (target.operationCreatedAt !== undefined && expired(target.operationCreatedAt));
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    let deadline = Infinity;
    for (const record of pending.values()) deadline = Math.min(deadline, record.createdAt + pendingLifetime);
    for (const target of documentTargets.values()) {
      deadline = Math.min(deadline, target.createdAt + pendingLifetime,
        (target.operationCreatedAt ?? target.createdAt) + pendingLifetime);
    }
    if (deadline === Infinity) {
      chrome.alarms.clear(expiryAlarm).catch(report);
      return;
    }
    expiryTimer = setTimeout(cleanupExpired, Math.max(0, deadline - Date.now()));
    // The alarm survives worker shutdown; the timer gives timely cleanup while
    // the native port keeps this worker alive. Neither is trusted for validity.
    chrome.alarms.create(expiryAlarm, { when: deadline }).catch(report);
  }

  function cleanupExpired() {
    for (const tabId of pending.keys()) freshRecord(tabId);
    for (const [id, target] of documentTargets) {
      if (targetExpired(target)) {
        documentTargets.delete(id);
        delete op.K[id];
      }
    }
    scheduleExpiry();
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
      scheduleExpiry();
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
      scheduleExpiry();
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
    if (record && expired(record.createdAt)) {
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
    scheduleExpiry();
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
    for (const [key, saved] of Object.entries(state)) {
      if (!key.startsWith(statePrefix)) continue;
      const tabId = Number(key.slice(statePrefix.length));
      if (!Number.isInteger(tabId) || tabId < 0 || saved?.schema !== 2 ||
          typeof saved.itemUUID !== "string" || !saved.itemUUID ||
          typeof saved.vaultUUID !== "string" || typeof saved.documentId !== "string" ||
          typeof saved.completed !== "boolean" ||
          typeof saved.documentURLHash !== "string" || !/^[a-f0-9]{64}$/.test(saved.documentURLHash) ||
          expired(saved.createdAt) || navigationVersions.has(tabId)) {
        await chrome.storage.session.remove(key);
        continue;
      }
      try {
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
        if (!frame || !urlKey(frame.url) || frame.documentId !== saved.documentId ||
            await fingerprint(frame.url) !== saved.documentURLHash ||
            navigationVersions.has(tabId) || expired(saved.createdAt)) {
          throw new Error("Abandoned navigation");
        }
        const record = {
          operation: { itemUUID: saved.itemUUID, vaultUUID: saved.vaultUUID,
            url: frame.url, nakedDomains: null, uuid: crypto.randomUUID(), context: null },
          createdAt: saved.createdAt, navigationVersion: 0,
          documentId: saved.documentId, documentURL: urlKey(frame.url),
          notifyOnLoad: true, completed: saved.completed
        };
        pending.set(tabId, record);
        if (!await currentDocument(tabId, record)) throw new Error("Abandoned navigation");
        track.call(op, record.operation, tabId);
        persist(tabId, record); // Rewrite through the allowlist, dropping any extra fields.
      } catch {
        op.clearGoAndFillForTab(tabId);
      }
    }
    cleanupExpired();
  }

  op.setToolbarButtonEnabled = function (enabled) {
    op.toolbarButtonEnabled = enabled;
    (enabled ? chrome.action.enable() : chrome.action.disable()).catch(report);
  };
  op.lastWindow = Date.now();
  op.setToolbarButtonEnabled(true);

  // The original native transport still handles authentication, encryption,
  // reconnect delays, and the legacy localhost WebSocket fallback. A recurring
  // alarm revives a worker if retry timers or an idle WebSocket are lost when
  // it shuts down. Chrome 120 permits a minimum alarm period of 30 seconds.
  globalThis.mv3ScheduleReconnect = function () {
    if (!desktopPaused) {
      chrome.alarms.create(reconnectAlarm, {
        delayInMinutes: 0.5, periodInMinutes: 0.5
      }).catch(report);
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
      // The legacy WebSocket transport has no pause() method of its own.
      if (this.c instanceof WebSocketConnection) this.c.disconnect({});
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
    if (Agent.c instanceof WebSocketConnection) globalThis.mv3ScheduleReconnect();
    else chrome.alarms.clear(reconnectAlarm).catch(report);
    // The bundle marks its port ready after delivering this event.
    queueMicrotask(flushBookmarks);
  });

  const ready = chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .then(restoreState).then(() => Agent.connect());
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
        scheduleExpiry();
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
    if (alarm.name === expiryAlarm) ready.then(cleanupExpired).catch(report);
    if (alarm.name === reconnectAlarm) {
      // A cold worker reconnects in `ready`; a live worker already has the
      // transport's retry timer. Do not open a competing connection here.
      ready.then(() => {
        if (desktopPaused || globalThis.C?.rejected()) {
          return chrome.alarms.clear(reconnectAlarm);
        }
      }).catch(report);
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
      if (tab.url === "https://agilebits.com/browsers/auth.html" && C) C.ub(tab);
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
    cleanupExpired();
    const target = documentTargets.get(message?.documentUUID);
    if (!target) return;
    (async () => {
      const [currentTab, frame] = await Promise.all([
        chrome.tabs.get(target.tabId),
        chrome.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId })
      ]);
      if (documentTargets.get(message.documentUUID) !== target ||
          target.version !== (navigationVersions.get(target.tabId) || 0) ||
          targetExpired(target) || currentTab.pendingUrl ||
          frame?.documentLifecycle !== "active" || frame.errorOccurred ||
          frame.documentId !== target.documentId || urlKey(frame.url) !== target.url) return;
      chrome.tabs.sendMessage(target.tabId, { name, message },
        { documentId: target.documentId }, () => { void chrome.runtime.lastError; });
    })().catch(() => {}); // Closed or replaced documents must not receive a fill.
  };
})();
