const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const sourceDir = path.join(__dirname, "../../src");
const settle = () => new Promise(resolve => setImmediate(resolve));

function event() {
  const listeners = [];
  return {
    addListener: listener => listeners.push(listener),
    emit: (...args) => listeners.forEach(listener => listener(...args))
  };
}

function storage(initial = {}) {
  const values = { ...initial };
  return {
    values,
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

async function loadWorker({ session = storage(), beforeReady = () => {} } = {}) {
  const ports = [];
  const timers = new Map();
  const errors = [];
  let timerId = 0;
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
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event() },
    contextMenus: { onClicked: event() },
    windows: { onFocusChanged: event() },
    tabs: { get: async id => ({ id }), onUpdated: event(), onRemoved: event() },
    webNavigation: { onBeforeNavigate: event(), onDOMContentLoaded: event() }
  };
  const context = vm.createContext({
    chrome, URL, crypto: webcrypto,
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
  assert.equal(ports.length, 1);
  return { context, chrome, ports, timers, local, session, errors };
}

module.exports = { loadWorker, settle, storage };
