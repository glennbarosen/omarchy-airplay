// Tests for the settings that reach the lazily started daemon's argv. Both
// values come from the user's shell.json, so both are whitelisted before they
// are allowed anywhere near a command line: free-form text never gets there.
//
// portRange exists because a host with UFW default-deny cannot receive the
// receiver's timing/audio traffic on OS-ephemeral ports. Confining the daemon
// to a known range is what makes a narrow firewall rule possible — the rule
// itself stays the user's job, this plugin never touches the firewall.

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadQmlJs } = require("./helpers/load.js");

const Proto = loadQmlJs("airplay/Protocol.js");

// ------------------------------------------------------------------- hwaccel

test("hwaccel passes doubletake's own encoder names through", () => {
  for (const value of ["auto", "vaapi", "nvenc", "openh264", "none"]) {
    assert.equal(Proto.validHwaccel(value), value);
  }
});

test("hwaccel falls back to auto for anything else", () => {
  for (const value of ["", "VAAPI", "vaapi; id", "x264", null, undefined, 7, {}]) {
    assert.equal(Proto.validHwaccel(value), "auto");
  }
});

// ----------------------------------------------------------------- portRange

test("the default port range is the documented one and satisfies the daemon's rule", () => {
  assert.equal(Proto.DEFAULT_PORT_RANGE, "60000-60010");
  const parsed = Proto.parsePortRange(Proto.DEFAULT_PORT_RANGE);
  assert.deepEqual(parsed, { min: 60000, max: 60010 });
});

test("parsePortRange accepts a valid range", () => {
  assert.deepEqual(Proto.parsePortRange("50000-50002"), { min: 50000, max: 50002 });
  assert.deepEqual(Proto.parsePortRange("1-65535"), { min: 1, max: 65535 });
  assert.deepEqual(Proto.parsePortRange("  60000-60010  "), { min: 60000, max: 60010 });
});

test("parsePortRange falls back to the default for a missing value", () => {
  const fallback = { min: 60000, max: 60010 };
  for (const value of [undefined, null, "", "   "]) {
    assert.deepEqual(Proto.parsePortRange(value), fallback);
  }
});

// The daemon's own validatePortRange: 1-65535, min <= max, at least 3 ports.
// Anything it would reject must be rejected here, before it reaches argv.
test("parsePortRange rejects out-of-bounds ports", () => {
  const fallback = { min: 60000, max: 60010 };
  for (const value of ["0-10", "0-0", "-5-10", "60000-65536", "70000-70010", "65535-65540"]) {
    assert.deepEqual(Proto.parsePortRange(value), fallback, `${value} must not be honoured`);
  }
});

test("parsePortRange rejects an inverted range", () => {
  assert.deepEqual(Proto.parsePortRange("60010-60000"), { min: 60000, max: 60010 });
});

test("parsePortRange rejects a range narrower than the three UDP ports doubletake needs", () => {
  const fallback = { min: 60000, max: 60010 };
  assert.deepEqual(Proto.parsePortRange("60000-60000"), fallback);
  assert.deepEqual(Proto.parsePortRange("60000-60001"), fallback);
  assert.deepEqual(Proto.parsePortRange("60000-60002"), { min: 60000, max: 60002 });
});

test("parsePortRange rejects anything that is not exactly MIN-MAX", () => {
  const fallback = { min: 60000, max: 60010 };
  for (const value of [
    "60000",
    "60000-",
    "-60010",
    "60000-60010-60020",
    "60000 60010",
    "60000:60010",
    "abc-def",
    "6e4-60010",
    "0x1-0xff",
    "60000.0-60010.0",
    "+60000--60010",
    "60000-60010; rm -rf /",
    "60000-60010\n{\"cmd\":\"disconnect\"}",
    "$(id)-60010",
    "60000-60010 --debug"
  ]) {
    assert.deepEqual(Proto.parsePortRange(value), fallback, `${JSON.stringify(value)} must be refused`);
  }
});

test("parsePortRange rejects non-string settings values", () => {
  const fallback = { min: 60000, max: 60010 };
  for (const value of [60000, true, {}, [], ["60000-60010"], { min: 1, max: 2 }]) {
    assert.deepEqual(Proto.parsePortRange(value), fallback);
  }
});

test("parsePortRange rejects leading zeros rather than reinterpreting them", () => {
  assert.deepEqual(Proto.parsePortRange("060000-060010"), { min: 60000, max: 60010 });
});

// -------------------------------------------------------- daemon argv assembly

test("portRangeArgs builds the flag from validated integers only", () => {
  assert.deepEqual(Proto.portRangeArgs("60000-60010"), ["-port-range", "60000-60010"]);
  assert.deepEqual(Proto.portRangeArgs("50000-50002"), ["-port-range", "50000-50002"]);
});

test("portRangeArgs never forwards the user's raw text", () => {
  const hostile = "60000-60010; rm -rf /";
  const args = Proto.portRangeArgs(hostile);
  assert.deepEqual(args, ["-port-range", "60000-60010"]);
  assert.equal(args.join(" ").includes("rm"), false);
});

test("daemonCommand starts doubletake with both whitelisted settings and nothing else", () => {
  assert.deepEqual(Proto.daemonCommand("vaapi", "60000-60010"), [
    "doubletake",
    "-daemonize",
    "-hwaccel",
    "vaapi",
    "-port-range",
    "60000-60010"
  ]);
});

test("daemonCommand sanitises both settings before they become argv", () => {
  assert.deepEqual(Proto.daemonCommand("x264; id", "$(id)"), [
    "doubletake",
    "-daemonize",
    "-hwaccel",
    "auto",
    "-port-range",
    "60000-60010"
  ]);
});

test("daemonCommand never carries a credential or a free-form field", () => {
  const command = Proto.daemonCommand("auto", "60000-60010");
  assert.equal(command.includes("1234"), false);
  assert.equal(command.indexOf("-pin"), -1);
  assert.equal(command.indexOf("-code"), -1);
  for (const argument of command) {
    assert.equal(typeof argument, "string");
    assert.equal(argument.includes("\n"), false);
    assert.equal(argument.includes(";"), false);
  }
});

test("daemonCommand is a plain argv, never a shell string", () => {
  const command = Proto.daemonCommand("auto", "60000-60010");
  assert.ok(Array.isArray(command));
  assert.equal(command[0], "doubletake");
  assert.equal(command.includes("sh"), false);
  assert.equal(command.includes("-c"), false);
});
