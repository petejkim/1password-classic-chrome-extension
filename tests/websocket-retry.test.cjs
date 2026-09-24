const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorker, settle } = require("./helpers/worker.cjs");

const reconnectAlarm = "onepassword-reconnect";

async function connectFallback(worker) {
  const { context, chrome, ports, timers } = worker;
  const sockets = [];
  chrome.windows.getCurrent = (options, callback) => callback({ focused: true });
  context.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.messages = [];
      sockets.push(this);
    }
    send(message) { this.messages.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  };
  // Exercise the real native-host failure path that selects the fallback.
  ports[0].closed = true;
  chrome.runtime.lastError = { message: "Specified native messaging host not found." };
  ports[0].onDisconnect.emit(ports[0]);
  delete chrome.runtime.lastError;
  await settle();
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers.entries()][0];
  timers.delete(id);
  timer.callback();
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  assert.equal(socket.messages[0].action, "hello", "recovery uses the existing handshake");
  socket.onmessage({ data: JSON.stringify({ action: "welcome", payload: { capabilities: [] } }) });
  await settle();
  assert.ok(context.Agent.c instanceof context.WebSocketConnection);
  return { sockets, socket };
}

test("WebSocket failures keep retrying with a delay capped at thirty seconds", async () => {
  const { context, timers } = await loadWorker();
  const sockets = [];
  context.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    close() { this.readyState = 3; }
  };
  const connection = new context.WebSocketConnection("com.google.Chrome", context.Agent);
  connection.connect();
  await settle();

  const delays = [];
  for (let attempt = 0; attempt < 180; attempt++) {
    assert.equal(timers.size, 1, "each failure schedules exactly one retry");
    const [id, timer] = [...timers.entries()][0];
    delays.push(timer.delay);
    assert.ok(timer.delay >= 0 && timer.delay <= 30000);
    timers.delete(id);
    timer.callback();
    assert.equal(sockets.length, attempt + 1);
    const socket = sockets.at(-1);
    socket.readyState = 3;
    socket.onclose({ code: 1006, reason: "helper unavailable" });
    await settle();
  }

  assert.equal(new Set(sockets.map(socket => socket.url)).size, 10,
    "retries continue scanning all candidate helper ports");
  assert.deepEqual(delays.filter(delay => delay !== 50),
    [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000,
      18000, 20000, 22000, 24000, 26000, 28000, 30000, 30000, 30000]);

  connection.resetParameters();
  assert.equal(timers.size, 0);
  connection.connect();
  await settle();
  assert.equal([...timers.values()][0].delay, 0,
    "resetting the connection clears the accumulated retry delay");
});

test("fallback recovery survives worker shutdown without opening duplicate live connections", async () => {
  const first = await loadWorker();
  const { sockets } = await connectFallback(first);
  const alarm = first.alarms.get(reconnectAlarm);
  assert.equal(alarm.delayInMinutes, 0.5);
  assert.equal(alarm.periodInMinutes, 0.5);
  for (let tick = 0; tick < 3; tick++) first.chrome.alarms.onAlarm.emit({ name: reconnectAlarm });
  await settle();
  assert.equal(first.ports.length, 1);
  assert.equal(sockets.length, 1);
  assert.equal(first.timers.size, 0);

  // Discard the old worker's memory/timers; only Chrome's session and alarms survive.
  const second = await loadWorker({
    session: first.session, alarms: first.alarms,
    beforeReady: chrome => chrome.alarms.onAlarm.emit({ name: reconnectAlarm })
  });
  assert.equal(second.ports.length, 1, "the alarm wakes a new native connection attempt");
  assert.equal(second.ports[0].messages[0].action, "hello");
  await connectFallback(second);
  assert.equal(second.alarms.get(reconnectAlarm).periodInMinutes, 0.5);
  assert.deepEqual(second.errors, []);
});

test("native connection success cancels periodic recovery", async () => {
  const first = await loadWorker();
  await connectFallback(first);
  const second = await loadWorker({ alarms: first.alarms });
  second.ports[0].onMessage.emit({ action: "welcome", payload: { capabilities: [] } });
  await settle();
  assert.equal(second.alarms.has(reconnectAlarm), false);
  second.chrome.alarms.onAlarm.emit({ name: reconnectAlarm });
  await settle();
  assert.equal(second.ports.length, 1, "a queued alarm cannot duplicate the native connection");
});

test("fallback retry timers and alarm recovery stop when the desktop pauses", async () => {
  const first = await loadWorker();
  const { socket } = await connectFallback(first);
  socket.readyState = 3;
  socket.onclose({ code: 1006, reason: "helper unavailable" });
  await settle();
  assert.equal(first.timers.size, 1);
  first.context.Agent.pause(Infinity);
  assert.equal(first.timers.size, 0);
  assert.equal(first.alarms.has(reconnectAlarm), false);
  first.chrome.alarms.onAlarm.emit({ name: reconnectAlarm });
  first.context.mv3ScheduleReconnect();
  await settle();
  assert.equal(first.alarms.has(reconnectAlarm), false);

  const second = await loadWorker({
    session: first.session,
    beforeReady: chrome => chrome.alarms.onAlarm.emit({ name: reconnectAlarm })
  });
  assert.equal(second.ports.length, 0, "a cold alarm respects the persisted pause");
  assert.equal(second.alarms.has(reconnectAlarm), false);
});

test("a rejected authorization stops periodic recovery", async () => {
  const worker = await loadWorker();
  const { socket } = await connectFallback(worker);
  // Suppress only the legacy welcome-page UI; retain the real authenticator.
  worker.context.OnePassword.ia = () => {};
  worker.context.C.reject();
  socket.readyState = 3;
  socket.onclose({ code: 1006, reason: "authorization rejected" });
  worker.chrome.alarms.onAlarm.emit({ name: reconnectAlarm });
  await settle();
  assert.equal(worker.alarms.has(reconnectAlarm), false);
  assert.equal(worker.timers.size, 0);
  assert.equal(worker.ports.length, 1);
});
