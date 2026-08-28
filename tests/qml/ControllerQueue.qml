import QtQuick
import Quickshell
import Quickshell.Io
import "airplay" as Airplay

ShellRoot {
  Item {
    id: driver

    property int answers: 0
    readonly property string fixturePath: String(
      Quickshell.env("AIRPLAY_QUEUE_FIXTURE") || ""
    )
    readonly property string socketPath: String(
      Quickshell.env("XDG_RUNTIME_DIR") || ""
    ) + "/doubletake.sock"

    function fail(reason) {
      console.error("QUEUE_FAIL " + reason)
      fixture.running = false
      Qt.exit(2)
    }

    Airplay.Controller {
      id: controller
      socketPathsOverride: [driver.socketPath]

      onAnswered: function (cmd, target, response) {
        driver.answers += 1
        if (response === null || !response.ok) {
          driver.fail("request " + cmd + " failed")
          return
        }
        if (driver.answers === 1 && (!controller.busy || cmd !== "status")) {
          driver.fail("interactive request was not running after poll response")
          return
        }
        if (driver.answers === 2) {
          if (cmd !== "connect" || controller.busy || controller.pending !== null) {
            driver.fail("queued credential request did not settle exactly once")
            return
          }
          console.log("QUEUE_PASS")
          fixture.running = false
          Qt.exit(0)
        }
      }
    }

    Process {
      id: fixture
      command: ["node", driver.fixturePath, driver.socketPath]

      stdout: SplitParser {
        splitMarker: "\n"
        onRead: function (line) {
          if (String(line).trim() !== "READY") return
          if (!controller.send("status", {})) {
            driver.fail("poll request was refused")
            return
          }
          if (!controller.send("connect", {
            target: "192.0.2.10",
            pin: "1234",
            interactive: true
          })) {
            driver.fail("credential request was not queued")
            return
          }
          if (controller.send("disconnect", {
            target: "192.0.2.11",
            interactive: true
          })) {
            driver.fail("interactive request queued behind another interactive request")
          }
        }
      }
    }

    Timer {
      interval: 12000
      running: true
      onTriggered: driver.fail("harness timed out")
    }

    Component.onCompleted: fixture.running = true
  }
}
