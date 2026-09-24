const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorker, settle } = require("./helpers/worker.cjs");

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
