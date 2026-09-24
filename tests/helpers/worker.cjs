const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");

const sourceDir = path.join(__dirname, "../../src");
const settle = () => new Promise(resolve => setImmediate(resolve));

function event(beforeEmit = () => {}) {
  const listeners = [];
  return {
    addListener: listener => listeners.push(listener),
    emit: (...args) => { beforeEmit(...args); listeners.forEach(listener => listener(...args)); }
  };
}

function storage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async setAccessLevel({ accessLevel }) { this.accessLevel = accessLevel; },
    get(key, callback) {
      const result = key === null ? { ...values }
        : Object.fromEntries([key].flat().filter(k => k in values).map(k => [k, values[k]]));
      if (callback) queueMicrotask(() => callback(result));
      else return Promise.resolve(result);
    },
    set(items, callback) {
      Object.assign(values, items);
      if (callback) queueMicrotask(callback);
      return Promise.resolve();
    },
    remove(key, callback) {
      for (const k of [key].flat()) delete values[k];
      if (callback) queueMicrotask(callback);
      return Promise.resolve();
    }
  };
}

async function loadWorker({ session = storage(), beforeReady = () => {},
  frames = new Map(), tabs = new Map(), alarms = new Map(), now = Date.now } = {}) {
  const ports = [];
  const timers = new Map();
  const errors = [];
  let timerId = 0;
  const sentMessages = [];
  const updateFrame = details => {
    frames.set(`${details.tabId}:${details.frameId}`, {
      ...details, documentLifecycle: details.documentLifecycle || "active", errorOccurred: false
    });
    if (details.frameId === 0) tabs.set(details.tabId, { id: details.tabId, url: details.url });
  };
  const local = storage({
    OPExtensionIdentifier: "old-id",
    "old-id": JSON.stringify({ extId: "old-id", state: "new" })
  });
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL: file => `chrome-extension://test-extension/${file}`,
      getPlatformInfo: callback => callback({ os: "mac" }),
      onMessage: event(), onInstalled: event(), onStartup: event(),
      connectNative() {
        const port = {
          onMessage: event(), onDisconnect: event(), messages: [], closed: false,
          postMessage(message) {
            assert.equal(this.closed, false, "messages must use a live port");
            this.messages.push(message);
          },
          // Chrome does not emit onDisconnect locally for an explicit close.
          disconnect() { this.closed = true; }
        };
        ports.push(port);
        return port;
      }
    },
    storage: { local, session },
    action: { enable: async () => {}, disable: async () => {}, onClicked: event() },
    alarms: {
      create: async (name, options) => { alarms.set(name, options); },
      clear: async name => alarms.delete(name), onAlarm: event()
    },
    contextMenus: { onClicked: event() },
    windows: { onFocusChanged: event() },
    tabs: {
      get: async id => tabs.get(id) || ({ id }), onUpdated: event(), onRemoved: event(),
      sendMessage: (...args) => { sentMessages.push(args); args.at(-1)?.({}); }
    },
    webNavigation: {
      getFrame: async ({ tabId, frameId }) => frames.get(`${tabId}:${frameId}`),
      onBeforeNavigate: event(details => {
        if (details.frameId === 0) tabs.set(details.tabId,
          { ...tabs.get(details.tabId), id: details.tabId, pendingUrl: details.url });
      }),
      onCommitted: event(updateFrame), onDOMContentLoaded: event(), onErrorOccurred: event(),
      onHistoryStateUpdated: event(updateFrame), onReferenceFragmentUpdated: event(updateFrame)
    }
  };
  const context = vm.createContext({
    chrome, URL, TextEncoder,
    crypto: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
      // Deterministic microtask scheduling instead of Node's worker-thread pool.
      subtle: { digest: async (algorithm, bytes) => {
        assert.equal(algorithm, "SHA-256");
        return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
      } }
    },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now()])); }
      static now() { return now(); }
    },
    navigator: { userAgent: "review-test", platform: "MacIntel" },
    console: { info() {}, warn() {}, log() {}, error: (...args) => errors.push(args) },
    queueMicrotask,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    importScripts: (...files) => files.forEach(run)
  });
  function run(file) {
    vm.runInContext(readFileSync(path.join(sourceDir, file), "utf8"), context, { filename: file });
  }
  run("service-worker.js");
  beforeReady(chrome);
  await settle();
  return { context, chrome, ports, timers, local, session, errors, frames, tabs, sentMessages, alarms };
}

module.exports = { loadWorker, settle, storage };
