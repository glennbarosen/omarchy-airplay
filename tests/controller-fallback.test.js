const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { repoRoot } = require("./helpers/load.js");

test("Controller falls back before writing to an unavailable runtime socket", { timeout: 20000 }, (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "airplay-fallback-"));
  const configDir = path.join(testDir, "shell");
  const harness = path.join(configDir, "ControllerFallback.qml");
  const primaryPath = path.join(testDir, "runtime.sock");
  const fallbackPath = path.join(testDir, "fallback.sock");

  try {
    fs.mkdirSync(configDir);
    fs.symlinkSync(path.join(repoRoot, "airplay"), path.join(configDir, "airplay"));
    fs.copyFileSync(path.join(repoRoot, "tests/qml/ControllerFallback.qml"), harness);

    const result = spawnSync("qs", ["-p", harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AIRPLAY_PRIMARY_SOCKET: primaryPath,
        AIRPLAY_FALLBACK_SOCKET: fallbackPath,
        AIRPLAY_FALLBACK_FIXTURE: path.join(
          repoRoot,
          "tests/fixtures/controller-reconnect-server.js"
        ),
        QT_QPA_PLATFORM: "offscreen",
        XDG_RUNTIME_DIR: testDir,
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
    assert.equal(result.status, 0, `Quickshell fallback harness failed:\n${output}`);
    assert.match(output, /FALLBACK_PASS/);
    assert.doesNotMatch(output, /FALLBACK_FAIL/);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
