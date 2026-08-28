import QtQuick
import Quickshell
import Quickshell.Io
import "airplay" as Airplay

ShellRoot {
  Item {
    id: driver

    property int attempt: 1
    readonly property string fixturePath: String(
      Quickshell.env("AIRPLAY_RECONNECT_FIXTURE") || ""
    )
    readonly property string socketPath: String(
      Quickshell.env("XDG_RUNTIME_DIR") || ""
    ) + "/doubletake.sock"

    function fail(reason) {
      console.error("RECONNECT_FAIL " + reason)
      fixture.running = false
      Qt.exit(2)
    }

    Airplay.Controller {
      id: controller
      socketPathsOverride: [driver.socketPath]

      onAnswered: function (cmd, target, response) {
        if (driver.attempt === 1) {
          if (response !== null) {
            driver.fail("first request unexpectedly succeeded")
            return
          }
          fixture.running = true
          return
        }

        if (response === null || !response.ok) {
          driver.fail("second request did not receive the fixture response")
          return
        }
        if (controller.pending !== null || controller.busy) {
          driver.fail("controller remained busy after reconnect")
          return
        }
        console.log("RECONNECT_PASS")
        fixture.running = false
        Qt.exit(0)
      }
    }

    Process {
      id: fixture
      command: ["node", driver.fixturePath, driver.socketPath]

      stdout: SplitParser {
        splitMarker: "\n"
        onRead: function (line) {
          if (String(line).trim() !== "READY") return
          driver.attempt = 2
          if (!controller.send("status", {})) {
            driver.fail("second request was refused")
          }
        }
      }
    }

    Timer {
      interval: 12000
      running: true
      onTriggered: driver.fail("harness timed out")
    }

    Component.onCompleted: {
      if (!controller.send("status", {})) {
        driver.fail("first request was refused")
      }
    }
  }
}
