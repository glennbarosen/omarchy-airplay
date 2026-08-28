const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { repoRoot } = require("./helpers/load.js");

test("Controller prioritizes one interactive request during polling", { timeout: 20000 }, (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "airplay-queue-"));
  const configDir = path.join(testDir, "shell");
  const harness = path.join(configDir, "ControllerQueue.qml");

  try {
    fs.mkdirSync(configDir);
    fs.symlinkSync(path.join(repoRoot, "airplay"), path.join(configDir, "airplay"));
    fs.copyFileSync(path.join(repoRoot, "tests/qml/ControllerQueue.qml"), harness);

    const result = spawnSync("qs", ["-p", harness], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AIRPLAY_QUEUE_FIXTURE: path.join(
          repoRoot,
          "tests/fixtures/controller-queue-server.js"
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
    assert.equal(result.status, 0, `Quickshell queue harness failed:\n${output}`);
    assert.match(output, /QUEUE_PASS/);
    assert.doesNotMatch(output, /QUEUE_FAIL/);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
