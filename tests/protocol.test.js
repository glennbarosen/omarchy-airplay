// Contract tests for airplay/Protocol.js — the pure half of the direct-socket
// control path. Everything the daemon can say to us, and everything we say to
// it, is decided here; Controller.qml only owns the Socket, the timer and the
// generation counter.
//
// The wire contract encoded below is doubletake's own daemon.Request /
// daemon.Response: one newline-terminated JSON object per request, one per
// response, fields cmd / target / port / pin.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadQmlJs } = require("./helpers/load.js");

const Proto = loadQmlJs("airplay/Protocol.js");

// ------------------------------------------------------------------ socket path

test("socketPath prefers XDG_RUNTIME_DIR", () => {
  assert.equal(
    Proto.socketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/run/user/1000/doubletake.sock"
  );
});

test("socketPath falls back to /tmp when XDG_RUNTIME_DIR is absent, empty or blank", () => {
  assert.equal(Proto.socketPath({}), "/tmp/doubletake.sock");
  assert.equal(Proto.socketPath({ XDG_RUNTIME_DIR: "" }), "/tmp/doubletake.sock");
  assert.equal(Proto.socketPath({ XDG_RUNTIME_DIR: "   " }), "/tmp/doubletake.sock");
  assert.equal(Proto.socketPath(null), "/tmp/doubletake.sock");
});

test("socketPath strips a trailing slash instead of doubling the separator", () => {
  assert.equal(
    Proto.socketPath({ XDG_RUNTIME_DIR: "/run/user/1000/" }),
    "/run/user/1000/doubletake.sock"
  );
});

test("socketPath never returns a relative or bare path", () => {
  for (const env of [{}, { XDG_RUNTIME_DIR: "relative/dir" }, { XDG_RUNTIME_DIR: "." }]) {
    const resolved = Proto.socketPath(env);
    assert.ok(resolved.startsWith("/"), `expected absolute path, got ${resolved}`);
    assert.notEqual(resolved, "/doubletake.sock");
  }
});

// The fallback must be decided before anything is written: writing against an
// unresolved path is how a request escapes to the wrong place, or silently
// vanishes, instead of failing closed.
test("canWrite refuses an unresolved socket path", () => {
  assert.equal(Proto.canWrite("", '{"cmd":"status"}\n'), false);
  assert.equal(Proto.canWrite("   ", '{"cmd":"status"}\n'), false);
  assert.equal(Proto.canWrite(null, '{"cmd":"status"}\n'), false);
  assert.equal(Proto.canWrite("doubletake.sock", '{"cmd":"status"}\n'), false);
});

test("canWrite refuses an empty or unterminated request line", () => {
  const sock = "/run/user/1000/doubletake.sock";
  assert.equal(Proto.canWrite(sock, ""), false);
  assert.equal(Proto.canWrite(sock, null), false);
  assert.equal(Proto.canWrite(sock, '{"cmd":"status"}'), false);
});

test("canWrite accepts a resolved path with one terminated request line", () => {
  assert.equal(Proto.canWrite("/run/user/1000/doubletake.sock", '{"cmd":"status"}\n'), true);
});

// ----------------------------------------------------------- response validation

test("parseResponse rejects everything that is not a daemon response object", () => {
  const rejected = [
    "",
    "   ",
    null,
    undefined,
    "not json",
    "null",
    "true",
    "42",
    '"a string"',
    "[]",
    '[{"ok":true,"state":"idle"}]',
    "{",
    '{"ok":true} trailing',
    '{"state":"idle"}',
    '{"ok":"yes","state":"idle"}',
    '{"ok":1,"state":"idle"}'
  ];
  for (const text of rejected) {
    assert.equal(Proto.parseResponse(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});

test("parseResponse accepts a well-formed response and tolerates the trailing newline", () => {
  const resp = Proto.parseResponse('{"ok":true,"state":"streaming"}\n');
  assert.equal(resp.ok, true);
  assert.equal(resp.state, "streaming");
});

test("parseResponse keeps the arrays the panel renders from", () => {
  const resp = Proto.parseResponse(
    '{"ok":true,"state":"idle","devices":[{"name":"TV","ip":"192.0.2.10"}],"streams":[]}'
  );
  assert.equal(resp.devices.length, 1);
  assert.deepEqual(resp.streams, []);
});

test("parseResponse rejects a response whose arrays are not arrays", () => {
  assert.equal(Proto.parseResponse('{"ok":true,"devices":{"nope":1}}'), null);
  assert.equal(Proto.parseResponse('{"ok":true,"streams":"nope"}'), null);
});

// ---------------------------------------------------------- request construction

test("buildRequest emits one newline-terminated JSON object for a bare command", () => {
  assert.equal(Proto.buildRequest("status", {}), '{"cmd":"status"}\n');
  assert.equal(Proto.buildRequest("devices", {}), '{"cmd":"devices"}\n');
  assert.equal(Proto.buildRequest("discover", {}), '{"cmd":"discover"}\n');
});

test("buildRequest omits target entirely for the all-streams commands", () => {
  assert.equal(Proto.buildRequest("disconnect", {}), '{"cmd":"disconnect"}\n');
  assert.equal(Proto.buildRequest("mute", {}), '{"cmd":"mute"}\n');
  assert.equal(Proto.buildRequest("unmute", {}), '{"cmd":"unmute"}\n');
});

test("buildRequest targets a single receiver when given one", () => {
  assert.equal(
    Proto.buildRequest("disconnect", { target: "192.0.2.10" }),
    '{"cmd":"disconnect","target":"192.0.2.10"}\n'
  );
  assert.equal(
    Proto.buildRequest("mute", { target: "192.0.2.10" }),
    '{"cmd":"mute","target":"192.0.2.10"}\n'
  );
});

test("buildRequest builds the reset-restore-token request the Source action sends", () => {
  assert.equal(
    Proto.buildRequest("reset-restore-token", { target: "192.0.2.10" }),
    '{"cmd":"reset-restore-token","target":"192.0.2.10"}\n'
  );
});

test("reset-restore-token without a target is refused, since the daemon rejects it", () => {
  assert.equal(Proto.buildRequest("reset-restore-token", {}), null);
  assert.equal(Proto.buildRequest("reset-restore-token", { target: "" }), null);
});

test("buildRequest carries the credential in the wire-compatible pin field", () => {
  assert.equal(
    Proto.buildRequest("connect", { target: "192.0.2.10", pin: "1234" }),
    '{"cmd":"connect","target":"192.0.2.10","pin":"1234"}\n'
  );
});

test("buildRequest sends a fixed password through the same pin field", () => {
  const line = Proto.buildRequest("connect", { target: "192.0.2.10", pin: "hunter2" });
  assert.equal(JSON.parse(line).pin, "hunter2");
});

test("buildRequest includes port only when the receiver advertised one", () => {
  assert.equal(
    Proto.buildRequest("connect", { target: "192.0.2.10", port: 7000 }),
    '{"cmd":"connect","target":"192.0.2.10","port":7000}\n'
  );
  assert.equal(
    Proto.buildRequest("connect", { target: "192.0.2.10", port: 0 }),
    '{"cmd":"connect","target":"192.0.2.10"}\n'
  );
  assert.equal(
    Proto.buildRequest("connect", { target: "192.0.2.10", port: "7000" }),
    '{"cmd":"connect","target":"192.0.2.10","port":7000}\n'
  );
});

test("buildRequest drops a port the daemon could never accept", () => {
  for (const port of [-1, 70000, 1.5, NaN, "abc"]) {
    const line = Proto.buildRequest("connect", { target: "192.0.2.10", port });
    assert.equal(JSON.parse(line).port, undefined, `port ${port} should be dropped`);
  }
});

test("buildRequest emits no field the daemon's Request struct does not declare", () => {
  const line = Proto.buildRequest("connect", {
    target: "192.0.2.10",
    pin: "1234",
    port: 7000,
    credential: "leaked",
    hwaccel: "vaapi"
  });
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["cmd", "pin", "port", "target"]);
});

test("buildRequest refuses a command outside the daemon's vocabulary", () => {
  for (const cmd of ["", "shutdown", "STATUS", "status; rm -rf /", "pin", null, undefined]) {
    assert.equal(Proto.buildRequest(cmd, { target: "192.0.2.10" }), null, `cmd ${cmd}`);
  }
});

test("buildRequest refuses a target that is not a plain host address", () => {
  for (const target of [
    "192.0.2.10 extra",
    "192.0.2.10\n{\"cmd\":\"disconnect\"}",
    "../../etc/passwd",
    "$(id)",
    "`id`",
    "192.0.2.10;id",
    "a".repeat(256)
  ]) {
    assert.equal(
      Proto.buildRequest("disconnect", { target }),
      null,
      `target ${JSON.stringify(target)} should be refused`
    );
  }
});

test("buildRequest accepts the address forms doubletake actually discovers", () => {
  for (const target of ["192.0.2.10", "10.0.0.1", "fe80::1", "apple-tv.local"]) {
    const line = Proto.buildRequest("disconnect", { target });
    assert.equal(JSON.parse(line).target, target);
  }
});

// A credential is attacker-influenced text typed by the user. It must never be
// able to close the JSON object and append a second request.
test("a credential containing newlines or quotes cannot inject a second request", () => {
  const hostile = '1234"}\n{"cmd":"disconnect"}\n';
  const line = Proto.buildRequest("connect", { target: "192.0.2.10", pin: hostile });
  assert.equal(line.indexOf("\n"), line.length - 1, "only the terminator may be a newline");
  assert.equal(line.split("\n").filter((part) => part !== "").length, 1);
  assert.equal(JSON.parse(line).pin, hostile);
});

test("every built request ends with exactly one newline", () => {
  const lines = [
    Proto.buildRequest("status", {}),
    Proto.buildRequest("connect", { target: "192.0.2.10", pin: "1234" }),
    Proto.buildRequest("reset-restore-token", { target: "192.0.2.10" })
  ];
  for (const line of lines) {
    assert.ok(line.endsWith("\n"));
    assert.equal(line.endsWith("\n\n"), false);
  }
});

// -------------------------------------------------- generation guard and cleanup

test("beginRequest stamps the caller's generation onto the pending request", () => {
  const pending = Proto.beginRequest(7, "connect", { target: "192.0.2.10", pin: "1234" });
  assert.equal(pending.generation, 7);
  assert.equal(pending.cmd, "connect");
  assert.equal(pending.target, "192.0.2.10");
  assert.equal(pending.done, false);
  assert.equal(pending.submitted, true, "a request carrying a credential is a submission");
});

test("beginRequest returns null when the request could not be built", () => {
  assert.equal(Proto.beginRequest(1, "shutdown", {}), null);
  assert.equal(Proto.beginRequest(1, "reset-restore-token", {}), null);
});

test("a response from a superseded generation is ignored", () => {
  const pending = Proto.beginRequest(3, "status", {});
  const result = Proto.acceptResponse(pending, 4, '{"ok":true,"state":"idle"}');
  assert.equal(result.accepted, false);
  assert.equal(result.response, null);
});

test("a matching generation is accepted once and only once", () => {
  const pending = Proto.beginRequest(3, "status", {});
  const first = Proto.acceptResponse(pending, 3, '{"ok":true,"state":"idle"}');
  assert.equal(first.accepted, true);
  assert.equal(first.response.state, "idle");

  const second = Proto.acceptResponse(pending, 3, '{"ok":true,"state":"streaming"}');
  assert.equal(second.accepted, false, "one request means one response");
});

test("an unparseable response is a transport failure, not a daemon answer", () => {
  const pending = Proto.beginRequest(1, "status", {});
  const result = Proto.acceptResponse(pending, 1, "garbage from a half-open socket");
  assert.equal(result.accepted, true);
  assert.equal(result.response, null);
  assert.equal(result.transportFailed, true);
});

test("the credential is dropped from the pending request once a response lands", () => {
  const pending = Proto.beginRequest(1, "connect", { target: "192.0.2.10", pin: "1234" });
  assert.ok(pending.line.includes("1234"), "the request line is the only copy while in flight");
  Proto.acceptResponse(pending, 1, '{"ok":true,"state":"streaming"}');
  assert.equal(pending.line, "");
  assert.equal(pending.done, true);
});

test("the credential is dropped when the request is aborted", () => {
  for (const reason of ["timeout", "socket-error", "disconnected", "superseded"]) {
    const pending = Proto.beginRequest(1, "connect", { target: "192.0.2.10", pin: "1234" });
    Proto.abortRequest(pending, reason);
    assert.equal(pending.line, "", `line must be cleared on ${reason}`);
    assert.equal(pending.done, true, `pending must be terminal on ${reason}`);
  }
});

test("an aborted request refuses a late response", () => {
  const pending = Proto.beginRequest(1, "connect", { target: "192.0.2.10", pin: "1234" });
  Proto.abortRequest(pending, "timeout");
  const late = Proto.acceptResponse(pending, 1, '{"ok":true,"state":"streaming"}');
  assert.equal(late.accepted, false);
  assert.equal(pending.line, "");
});

test("no pending request survives cleanup with a credential still on it", () => {
  const pending = Proto.beginRequest(1, "connect", { target: "192.0.2.10", pin: "hunter2" });
  Proto.acceptResponse(pending, 1, '{"ok":false,"state":"idle","error":"nope"}');
  assert.equal(JSON.stringify(pending).includes("hunter2"), false);
});

test("the request timeout is bounded and short enough to unstick the panel", () => {
  assert.ok(Proto.REQUEST_TIMEOUT_MS > 0);
  assert.ok(Proto.REQUEST_TIMEOUT_MS <= 10000);
});

// -------------------------------------------------------------- error sanitising

test("sanitizeError never repeats the daemon's raw text", () => {
  const raw =
    "dial unix /run/user/1000/doubletake.sock: connect: no such file; creds /home/glenn/.config/doubletake/credentials.json";
  const message = Proto.sanitizeError("connect", { ok: false, error: raw });
  assert.equal(message.includes(raw), false);
  assert.equal(message.includes("/run/user"), false);
  assert.equal(message.includes("credentials.json"), false);
  assert.equal(message.includes("/home/"), false);
});

test("sanitizeError never echoes a credential the daemon quoted back", () => {
  const message = Proto.sanitizeError("connect", {
    ok: false,
    error: 'pairing rejected for pin "1234" (password "hunter2")'
  });
  assert.equal(message.includes("1234"), false);
  assert.equal(message.includes("hunter2"), false);
});

test("sanitizeError says something true and specific per action", () => {
  assert.match(Proto.sanitizeError("connect", { ok: false }), /mirror/i);
  assert.match(Proto.sanitizeError("disconnect", { ok: false }), /stop/i);
  assert.match(Proto.sanitizeError("reset-restore-token", { ok: false }), /source|share/i);
  assert.match(Proto.sanitizeError("mute", { ok: false }), /audio/i);
});

test("sanitizeError reports a transport failure without naming the socket", () => {
  const message = Proto.sanitizeError("status", null);
  assert.ok(message.length > 0);
  assert.equal(message.includes("sock"), false);
  assert.match(message, /AirPlay service/i);
});

test("sanitizeError produces one short line, never a stack or a multi-line dump", () => {
  const message = Proto.sanitizeError("connect", {
    ok: false,
    error: "line one\nline two\nline three"
  });
  assert.equal(message.includes("\n"), false);
  assert.ok(message.length <= 120);
});

// --------------------------------------------------------------- poll scheduling

test("pollInterval keeps the cadence the design contract documents", () => {
  assert.equal(Proto.pollInterval({ open: true, settling: true, starting: false, mirroring: false }), 1000);
  assert.equal(Proto.pollInterval({ open: true, settling: false, starting: true, mirroring: false }), 1000);
  assert.equal(Proto.pollInterval({ open: true, settling: false, starting: false, mirroring: false }), 3000);
  assert.equal(Proto.pollInterval({ open: false, settling: false, starting: false, mirroring: true }), 10000);
});

test("polling stops when the panel is closed and nothing is live", () => {
  assert.equal(Proto.pollInterval({ open: false, settling: false, starting: false, mirroring: false }), 0);
  assert.equal(Proto.shouldPoll({ open: false, settling: false, starting: false, mirroring: false }), false);
  assert.equal(Proto.shouldPoll({ open: false, settling: false, starting: false, mirroring: true }), true);
  assert.equal(Proto.shouldPoll({ open: true, settling: false, starting: false, mirroring: false }), true);
});

test("a closed panel never polls at the open cadence, even while settling", () => {
  assert.equal(
    Proto.pollInterval({ open: false, settling: true, starting: true, mirroring: true }),
    10000
  );
});
