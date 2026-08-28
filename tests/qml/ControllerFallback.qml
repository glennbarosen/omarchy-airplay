import QtQuick
import Quickshell
import Quickshell.Io
import "airplay" as Airplay

ShellRoot {
  Item {
    id: driver

    readonly property string primaryPath: String(
      Quickshell.env("AIRPLAY_PRIMARY_SOCKET") || ""
    )
    readonly property string fallbackPath: String(
      Quickshell.env("AIRPLAY_FALLBACK_SOCKET") || ""
    )
    readonly property string fixturePath: String(
      Quickshell.env("AIRPLAY_FALLBACK_FIXTURE") || ""
    )

    function fail(reason) {
      console.error("FALLBACK_FAIL " + reason)
      fixture.running = false
      Qt.exit(2)
    }

    Airplay.Controller {
      id: controller
      socketPathsOverride: [driver.primaryPath, driver.fallbackPath]

      onAnswered: function (cmd, target, response) {
        if (response === null || !response.ok) {
          driver.fail("fallback request did not receive the fixture response")
          return
        }
        if (controller.pending !== null || controller.busy) {
          driver.fail("controller remained busy after fallback")
          return
        }
        console.log("FALLBACK_PASS")
        fixture.running = false
        Qt.exit(0)
      }
    }

    Process {
      id: fixture
      command: ["node", driver.fixturePath, driver.fallbackPath]

      stdout: SplitParser {
        splitMarker: "\n"
        onRead: function (line) {
          if (String(line).trim() !== "READY") return
          if (!controller.send("status", {})) {
            driver.fail("fallback request was refused")
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
