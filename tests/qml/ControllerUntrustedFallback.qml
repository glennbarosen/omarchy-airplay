import QtQuick
import Quickshell
import Quickshell.Io
import "airplay" as Airplay

ShellRoot {
  Item {
    id: driver

    readonly property string fixturePath: String(
      Quickshell.env("AIRPLAY_ATTACKER_FIXTURE") || ""
    )
    readonly property string primaryPath: String(
      Quickshell.env("XDG_RUNTIME_DIR") || ""
    ) + "/missing.sock"

    function fail(reason) {
      console.error("UNTRUSTED_FAIL " + reason)
      fixture.running = false
      Qt.exit(2)
    }

    Airplay.Controller {
      id: controller
      socketPathsOverride: [driver.primaryPath, "/tmp/doubletake.sock"]

      onAnswered: function (cmd, target, response, failureKind) {
        if (response !== null || failureKind !== "socketUnavailable") {
          driver.fail("untrusted fallback did not fail closed")
          return
        }
        console.log("UNTRUSTED_PASS")
        fixture.running = false
        Qt.exit(0)
      }
    }

    Process {
      id: fixture
      command: ["node", driver.fixturePath]

      stdout: SplitParser {
        splitMarker: "\n"
        onRead: function (line) {
          var value = String(line).trim()
          if (value === "LEAK") {
            driver.fail("credential reached the untrusted socket")
            return
          }
          if (value !== "READY") return
          if (!controller.send("connect", {
            target: "192.0.2.10",
            pin: "1234",
            interactive: true
          })) {
            driver.fail("initial protected-path request was refused")
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
