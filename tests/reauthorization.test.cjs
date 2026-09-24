const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const sourceDir = path.join(__dirname, "../src");
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

async function loadWorker() {
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
    storage: { local, session: storage() },
    action: { enable: async () => {}, disable: async () => {}, onClicked: event() },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event() },
    contextMenus: { onClicked: event() },
    windows: { onFocusChanged: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
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
  await settle();
  assert.equal(ports.length, 1);
  return { context, ports, timers, local, errors };
}

test("bad-mac reauthorization closes the old port and sends a fresh hello", async () => {
  const { context, ports, timers, local, errors } = await loadWorker();
  const oldPort = ports[0];
  const oldAuthenticator = context.C;
  assert.equal(oldPort.messages[0].payload.extId, "old-id");

  // Exercise the real legacy transport and authenticator, not a stub of connect.
  oldPort.onMessage.emit({ action: "authFail", payload: { reason: "bad-mac" } });
  await settle();
  assert.equal(local.values.OPExtensionIdentifier, undefined);
  assert.equal(local.values["old-id"], undefined);
  const retry = [...timers.values()].find(timer => timer.delay === 250);
  assert.ok(retry, "legacy reauthorization must schedule its forced reconnect");
  errors.length = 0; // The injected authentication failure is expected to log.
  retry.callback();
  context.Agent.connect(); // Must not overlap the replacement's async setup.
  await settle();

  assert.equal(oldPort.closed, true);
  assert.equal(ports.length, 2);
  assert.equal(ports.filter(port => !port.closed).length, 1);
  assert.notEqual(context.C, oldAuthenticator);
  const hello = ports[1].messages[0];
  assert.equal(hello.action, "hello");
  assert.notEqual(hello.payload.extId, "old-id");
  assert.equal(hello.payload.extId, local.values.OPExtensionIdentifier);
  assert.deepEqual(errors, []);
});

test("ordinary connects remain guarded and forced connects respect desktop pause", async () => {
  const { context, ports, errors } = await loadWorker();
  context.Agent.connect();
  await settle();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].closed, false);

  context.Agent.connect(true);
  context.Agent.connect(true); // Coalesce while the replacement is initializing.
  await settle();
  assert.equal(ports.length, 2);
  assert.equal(ports[0].closed, true);
  assert.equal(ports[1].closed, false);

  context.Agent.pause(Infinity);
  context.Agent.connect(true);
  await settle();
  assert.equal(ports.length, 2);
  assert.equal(ports[1].closed, true);
  assert.deepEqual(errors, []);
});
