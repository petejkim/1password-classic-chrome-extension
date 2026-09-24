const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorker, settle, storage } = require("./helpers/worker.cjs");

const bookmarkURL = "https://example.com/login?next=%2Fhome&onepasswdfill=ITEM&onepasswdvault=VAULT#sign-in";
const destination = "https://example.com/login?next=%2Fhome#sign-in";
const navigation = (url, tabId = 10, frameId = 0) => ({
  url, tabId, frameId, documentId: `doc-${tabId}`, documentLifecycle: "active"
});
const loadedBookmarks = port => port.messages.filter(message => message.action === "loginBookmarkLoaded");
const welcome = port => port.onMessage.emit({ action: "welcome", payload: { capabilities: [] } });

test("a cold worker tracks the original navigation before completion and desktop connection", async () => {
  const { chrome, context, ports, session, errors } = await loadWorker({
    beforeReady(chrome) {
      chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
      chrome.webNavigation.onCommitted.emit(navigation(destination));
      chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination));
    }
  });
  const operation = context.OnePassword.goAndFillOperationForTabReference(10);
  assert.equal(operation.itemUUID, "ITEM");
  assert.equal(operation.vaultUUID, "VAULT");
  assert.equal(operation.url, destination);
  assert.equal(session.values["mv3.goAndFill.10"].completed, true);
  assert.equal(loadedBookmarks(ports[0]).length, 0, "wait for the desktop handshake");

  welcome(ports[0]);
  await settle();
  assert.equal(loadedBookmarks(ports[0]).length, 1);
  assert.equal(loadedBookmarks(ports[0])[0].payload.uuid, "ITEM");
  assert.equal(loadedBookmarks(ports[0])[0].payload.vaultUUID, "VAULT");
  chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination));
  await settle();
  assert.equal(loadedBookmarks(ports[0]).length, 1, "notify the desktop only once");
  assert.deepEqual(errors, []);
});

test("pending bookmarks survive worker restart and remain associated with their tabs", async () => {
  const session = storage();
  const frames = new Map();
  const first = await loadWorker({ session, frames });
  first.chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL, 10));
  first.chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL.replace("ITEM", "OTHER"), 20));
  first.chrome.webNavigation.onCommitted.emit(navigation(destination, 10));
  first.chrome.webNavigation.onCommitted.emit(navigation(destination, 20));
  await settle();

  const second = await loadWorker({ session, frames });
  welcome(second.ports[0]);
  second.chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination, 20));
  await settle();
  assert.equal(loadedBookmarks(second.ports[0])[0].payload.uuid, "OTHER");
  assert.equal(session.values["mv3.goAndFill.10"].notifyOnLoad, true);
  second.chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination, 10));
  await settle();
  assert.equal(loadedBookmarks(second.ports[0])[1].payload.uuid, "ITEM");
  second.chrome.tabs.onRemoved.emit(20);
  await settle();
  assert.equal(session.values["mv3.goAndFill.20"], undefined);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
});

test("subframes, non-web URLs, and URLs without an item ID do not schedule bookmarks", async () => {
  const { chrome, session, errors } = await loadWorker();
  for (const details of [
    navigation(bookmarkURL, 10, 1),
    navigation("chrome-extension://test-extension/?onepasswdfill=ITEM"),
    navigation("https://example.com/login?onepasswdfill="),
    navigation(destination)
  ]) chrome.webNavigation.onBeforeNavigate.emit(details);
  await settle();
  assert.deepEqual(session.values, {});
  assert.deepEqual(errors, []);
});

async function loadedBookmark(options = {}) {
  return loadWorker({ ...options, beforeReady(chrome) {
    chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
    chrome.webNavigation.onCommitted.emit(navigation(destination));
    chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination));
  } });
}

test("abandoned, failed, reloaded, and same-document navigations cannot replay a bookmark", async () => {
  for (const eventName of ["onBeforeNavigate", "onErrorOccurred", "onHistoryStateUpdated",
    "onReferenceFragmentUpdated"]) {
    const { chrome, ports, session, errors } = await loadedBookmark();
    chrome.webNavigation[eventName].emit(navigation(destination));
    chrome.webNavigation.onDOMContentLoaded.emit(navigation(destination));
    welcome(ports[0]);
    await settle();
    assert.equal(loadedBookmarks(ports[0]).length, 0, eventName);
    assert.equal(session.values["mv3.goAndFill.10"], undefined, eventName);
    assert.deepEqual(errors, []);
  }
});

test("an unrelated navigation during cold startup invalidates earlier queued events", async () => {
  const { ports, session } = await loadWorker({ beforeReady(chrome) {
    chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
    chrome.webNavigation.onBeforeNavigate.emit(navigation("https://unrelated.example/"));
    chrome.webNavigation.onCommitted.emit(navigation("https://unrelated.example/"));
    chrome.webNavigation.onDOMContentLoaded.emit(navigation("https://unrelated.example/"));
  } });
  welcome(ports[0]);
  await settle();
  assert.equal(loadedBookmarks(ports[0]).length, 0);
  assert.equal(session.values["mv3.goAndFill.10"], undefined);
});

test("server redirects bind to the committed document, not a later document at the same URL", async () => {
  const { chrome, ports } = await loadWorker();
  const redirected = "https://login.example.com/sign-in";
  chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
  chrome.webNavigation.onCommitted.emit({ ...navigation(redirected), transitionQualifiers: ["server_redirect"] });
  chrome.webNavigation.onDOMContentLoaded.emit({ ...navigation(redirected), documentId: "wrong-document" });
  welcome(ports[0]);
  await settle();
  assert.equal(loadedBookmarks(ports[0]).length, 0);
  chrome.webNavigation.onDOMContentLoaded.emit(navigation(redirected));
  await settle();
  assert.equal(loadedBookmarks(ports[0]).length, 1);
});

test("restoration rejects replaced documents and operations that never committed", async () => {
  const first = await loadedBookmark();
  first.frames.set("10:0", { ...navigation(destination), documentId: "replacement" });
  const restarted = await loadWorker({ session: first.session, frames: first.frames });
  welcome(restarted.ports[0]);
  await settle();
  assert.equal(loadedBookmarks(restarted.ports[0]).length, 0);
  assert.equal(first.session.values["mv3.goAndFill.10"], undefined);

  const incomplete = await loadWorker();
  incomplete.chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
  await settle();
  await loadWorker({ session: incomplete.session });
  assert.equal(incomplete.session.values["mv3.goAndFill.10"], undefined);
});

test("expiry and navigation during asynchronous validation prevent bookmark delivery", async () => {
  let time = Date.now();
  const expired = await loadedBookmark({ now: () => time });
  time += 120000;
  welcome(expired.ports[0]);
  await settle();
  assert.equal(loadedBookmarks(expired.ports[0]).length, 0);
  assert.equal(expired.session.values["mv3.goAndFill.10"], undefined);

  const racing = await loadedBookmark();
  let release;
  const oldFrame = racing.frames.get("10:0");
  racing.chrome.webNavigation.getFrame = () => new Promise(resolve => { release = resolve; });
  welcome(racing.ports[0]);
  await settle();
  racing.chrome.webNavigation.onBeforeNavigate.emit(navigation("https://unrelated.example/"));
  release(oldFrame);
  await settle();
  assert.equal(loadedBookmarks(racing.ports[0]).length, 0);
});

test("credential messages are pinned to the collecting document and canceled on navigation", async () => {
  const worker = await loadedBookmark();
  const { context, chrome, sentMessages } = worker;
  chrome.runtime.onMessage.emit({ command: "collectDocumentResults", params: {
    documentUUID: "extension-document", url: destination, context: "collection",
    fields: { fields: [] }
  } }, { id: chrome.runtime.id, tab: { id: 10 }, frameId: 0,
    documentId: "doc-10", url: destination }, () => {});
  await settle();
  const message = { documentUUID: "extension-document", script: [] };
  context.z(10, "executeFillScript", message);
  await settle();
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0][2].documentId, "doc-10");

  let release;
  const oldFrame = worker.frames.get("10:0");
  chrome.webNavigation.getFrame = () => new Promise(resolve => { release = resolve; });
  context.z(10, "executeFillScript", message);
  chrome.webNavigation.onBeforeNavigate.emit(navigation(destination));
  release(oldFrame);
  await settle();
  assert.equal(sentMessages.length, 1, "a delayed fill must not reach a replacement page");
});
