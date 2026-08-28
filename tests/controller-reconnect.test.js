const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { repoRoot } = require("./helpers/load.js");

test("Controller reconnects after the daemon appears", { timeout: 20000 }, (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "airplay-controller-"));
  const runtimeDir = path.join(testDir, "run");
  const configDir = path.join(testDir, "shell");
  const harness = path.join(configDir, "ControllerReconnect.qml");

  try {
    fs.mkdirSync(runtimeDir);
    fs.mkdirSync(configDir);
    fs.symlinkSync(path.join(repoRoot, "airplay"), path.join(configDir, "airplay"));
    fs.copyFileSync(
      path.join(repoRoot, "tests/qml/ControllerReconnect.qml"),
      harness
    );

    const result = spawnSync("qs", ["-p", harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AIRPLAY_RECONNECT_FIXTURE: path.join(
          repoRoot,
          "tests/fixtures/controller-reconnect-server.js"
        ),
        QT_QPA_PLATFORM: "offscreen",
        XDG_RUNTIME_DIR: runtimeDir,
      },
      encoding: "utf8",
      timeout: 15000,
    });

    if (result.error?.code === "ENOENT") {
      t.skip("Quickshell is not installed");
      return;
    }
    if (result.error) throw result.error;

    const output = result.stdout + result.stderr;
    assert.equal(
      result.status,
      0,
      `Quickshell reconnect harness failed:\n${output}`
    );
    assert.match(output, /RECONNECT_PASS/);
    assert.doesNotMatch(output, /RECONNECT_FAIL/);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
