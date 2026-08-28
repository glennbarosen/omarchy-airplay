const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { repoRoot } = require("./helpers/load.js");

test("Controller never sends credentials to the global tmp fallback", { timeout: 20000 }, (t) => {
  if (fs.existsSync("/tmp/doubletake.sock")) {
    t.skip("/tmp/doubletake.sock already exists");
    return;
  }
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "airplay-untrusted-"));
  const configDir = path.join(testDir, "shell");
  const harness = path.join(configDir, "ControllerUntrustedFallback.qml");

  try {
    fs.mkdirSync(configDir);
    fs.symlinkSync(path.join(repoRoot, "airplay"), path.join(configDir, "airplay"));
    fs.copyFileSync(
      path.join(repoRoot, "tests/qml/ControllerUntrustedFallback.qml"),
      harness
    );
    const result = spawnSync("qs", ["-p", harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AIRPLAY_ATTACKER_FIXTURE: path.join(
          repoRoot,
          "tests/fixtures/controller-attacker-server.js"
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
    assert.equal(result.status, 0, `untrusted fallback harness failed:\n${output}`);
    assert.match(output, /UNTRUSTED_PASS/);
    assert.doesNotMatch(output, /LEAK|UNTRUSTED_FAIL/);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
