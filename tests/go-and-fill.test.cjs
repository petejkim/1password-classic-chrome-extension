const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorker, settle, storage } = require("./helpers/worker.cjs");

const bookmarkURL = "https://example.com/login?next=%2Fhome&onepasswdfill=ITEM&onepasswdvault=VAULT#sign-in";
const destination = "https://example.com/login?next=%2Fhome#sign-in";
const navigation = (url, tabId = 10, frameId = 0) => ({ url, tabId, frameId });
const loadedBookmarks = port => port.messages.filter(message => message.action === "loginBookmarkLoaded");
const welcome = port => port.onMessage.emit({ action: "welcome", payload: { capabilities: [] } });

test("a cold worker tracks the original navigation before completion and desktop connection", async () => {
  const { chrome, context, ports, session, errors } = await loadWorker({
    beforeReady(chrome) {
      chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL));
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
  const first = await loadWorker({ session });
  first.chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL, 10));
  first.chrome.webNavigation.onBeforeNavigate.emit(navigation(bookmarkURL.replace("ITEM", "OTHER"), 20));
  await settle();

  const second = await loadWorker({ session });
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
