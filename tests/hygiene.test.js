// Static invariants for the shipped plugin. These are the properties a reader
// auditing this widget before enabling it should be able to trust without
// running it: no control subprocesses, no credential on any command line, no
// helper that rewrites doubletake's credentials file.
//
// Only machine-consumed values are asserted here — file existence, source
// constructs, and manifest fields. Documentation wording is deliberately not
// pinned.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { repoRoot } = require("./helpers/load.js");

const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));

const shippedQml = ["Panel.qml", "airplay/Section.qml", "airplay/Controller.qml"];
const shippedSource = [...shippedQml, "airplay/Model.js", "airplay/Protocol.js"];

// ------------------------------------------------------------------- removals

test("the reshare helper is gone", () => {
  assert.equal(exists("airplay/reshare.sh"), false);
});

test("no shell script ships with the plugin at all", () => {
  const shellScripts = fs
    .readdirSync(path.join(repoRoot, "airplay"))
    .filter((name) => name.endsWith(".sh"));
  assert.deepEqual(shellScripts, []);
});

test("no shipped source spawns a doubletake-ctl control subprocess", () => {
  for (const file of shippedSource) {
    assert.equal(
      read(file).includes("doubletake-ctl"),
      false,
      `${file} still references doubletake-ctl`
    );
  }
});

test("no shipped source rewrites doubletake's credentials file or signals its daemon", () => {
  const forbidden = ["credentials.json", "jq ", "pkill", "mktemp", "setsid", "DOUBLETAKE_CREDS"];
  for (const file of shippedSource) {
    const source = read(file);
    for (const needle of forbidden) {
      assert.equal(source.includes(needle), false, `${file} still contains ${needle.trim()}`);
    }
  }
});

test("the only subprocesses left are the availability probe and the daemon start", () => {
  const section = read("airplay/Section.qml");
  const processBlocks = section.match(/\bProcess\s*\{/g) || [];
  assert.equal(processBlocks.length, 1, "exactly one Process, the binary availability probe");

  const detached = section.match(/execDetached/g) || [];
  assert.equal(detached.length, 1, "exactly one detached spawn, the lazy daemon start");
});

test("the availability probe no longer requires the control binary", () => {
  const section = read("airplay/Section.qml");
  const probe = /command -v doubletake\b(?!-)/.test(section);
  assert.ok(probe, "probe should test for the doubletake binary");
  assert.equal(section.includes("command -v doubletake-ctl"), false);
});

// -------------------------------------------------------------- no secret leaks

test("no credential is ever pushed onto a command array", () => {
  for (const file of shippedQml) {
    const source = read(file);
    assert.equal(/command\s*=\s*\[[^\]]*credential/i.test(source), false, `${file}`);
    assert.equal(/command\.push/.test(source), false, `${file}`);
    assert.equal(/execDetached\([^)]*credential/i.test(source), false, `${file}`);
    assert.equal(/execDetached\([^)]*\bpin\b/i.test(source), false, `${file}`);
  }
});

test("no shipped source logs, prints or warns", () => {
  for (const file of shippedSource) {
    const source = read(file);
    for (const needle of ["console.log", "console.warn", "console.error", "print("]) {
      assert.equal(source.includes(needle), false, `${file} still calls ${needle}`);
    }
  }
});

// --------------------------------------------------------------- socket control

test("the controller exists and drives a real socket", () => {
  assert.ok(exists("airplay/Controller.qml"));
  const controller = read("airplay/Controller.qml");
  assert.ok(controller.includes("import Quickshell.Io"));
  assert.match(controller, /Socket\s*\{/);
  assert.match(controller, /SplitParser\s*\{/);
  assert.match(controller, /splitMarker:\s*"\\n"/);
  assert.match(controller, /\.flush\(\)/, "a request must be flushed, not left buffered");
});

test("the controller bounds every request with a timeout", () => {
  const controller = read("airplay/Controller.qml");
  assert.match(controller, /Timer\s*\{/);
  assert.ok(controller.includes("REQUEST_TIMEOUT_MS"));
});

test("the section talks to the controller, not to a process, for every action", () => {
  const section = read("airplay/Section.qml");
  for (const call of [
    "reset-restore-token",
    "connect",
    "disconnect",
    "mute",
    "unmute",
    "status",
    "devices",
    "discover"
  ]) {
    assert.ok(section.includes(call), `section should still drive the ${call} command`);
  }
});

// -------------------------------------------------------------------- manifest

test("the manifest declares the portRange setting with the documented default", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const schema = manifest.barWidget.schema;
  const entry = schema.find((item) => item.key === "portRange");
  assert.ok(entry, "portRange must be declared so the settings UI offers it");
  assert.equal(entry.type, "string");
  assert.equal(entry.defaultValue, "60000-60010");
});

test("the manifest still declares hwaccel and adds no other settings", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const keys = manifest.barWidget.schema.map((item) => item.key).sort();
  assert.deepEqual(keys, ["hwaccel", "portRange"]);
});

test("the manifest version moved past the subprocess release", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.notEqual(manifest.version, "1.0.0");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("the design contract is preserved alongside the code", () => {
  assert.ok(exists("DESIGN.md"));
});
