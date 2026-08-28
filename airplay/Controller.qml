import QtQuick
import Quickshell
import Quickshell.Io
import "Protocol.js" as Protocol

// One request, one response, one socket connection.
//
// doubletake's daemon answers a single newline-terminated JSON object per
// connection and then closes it (its handler reads one request, writes one
// response, and returns). So this controller connects per request rather than
// holding a session open: `send()` resolves the socket path, builds the line,
// opens the connection, writes on connect, flushes, and waits for one line.
//
// WHY THIS EXISTS
// The credential a receiver asks for used to travel as a control subprocess
// argv element, briefly readable in `ps` by any process of this user. Writing
// it into the socket instead keeps it inside this process
// and the daemon; it never reaches a command line, a file, or a log.
//
// The one-request lifecycle, bounded cleanup and generation-guard approach
// substantially reuse implementation concepts from Mathias Ringhof's
// omarchy-airplay implementation (source attribution in README.md).
//
// Every terminal path — response, parse failure, socket error, disconnect,
// timeout, supersession — runs through `settle()`, which drops the request
// line (the only copy of the credential) and frees the controller for the next
// request. A generation counter makes a late answer from an abandoned request
// unable to land on a newer one.
Item {
  id: controller

  // Emitted once per request. `response` is the parsed daemon object, or null
  // when nothing usable came back; `cmd` and `target` identify what was asked.
  signal answered(string cmd, string target, var response)

  readonly property bool busy: pending !== null

  // Resolved once, before any write, so a request can never be aimed at an
  // unresolved path. Mirrors doubletake's own default: XDG_RUNTIME_DIR, else
  // /tmp.
  readonly property string path: Protocol.socketPath({
    XDG_RUNTIME_DIR: String(Quickshell.env("XDG_RUNTIME_DIR") || "")
  })

  property var pending: null
  property int generation: 0

  // Sends one command. Returns false when the request was refused before it
  // could be written — an unknown command, a malformed target, a path that did
  // not resolve, or a request already in flight.
  function send(cmd, options) {
    if (controller.pending !== null) return false

    controller.generation += 1
    var request = Protocol.beginRequest(controller.generation, cmd, options)
    if (request === null) return false
    if (!Protocol.canWrite(controller.path, request.line)) return false

    controller.pending = request
    timeout.restart()
    socket.path = controller.path
    socket.connected = true
    return true
  }

  // The single exit. Whatever happened, the credential-bearing line is dropped
  // here, the socket is closed, and the result is reported exactly once.
  function settle(response) {
    var request = controller.pending
    if (request === null) return

    var cmd = request.cmd
    var target = request.target
    Protocol.finishRequest(request)
    controller.pending = null

    timeout.stop()
    socket.connected = false

    controller.answered(cmd, target, response)
  }

  Socket {
    id: socket

    onConnectionStateChanged: {
      if (connected) {
        var request = controller.pending
        if (request === null || request.done) {
          socket.connected = false
          return
        }
        // Written and flushed in the same turn: the daemon reads one line and
        // will not answer until it has one.
        socket.write(request.line)
        socket.flush()
        // The line was the only copy of the credential; the request stays in
        // flight but the secret is gone from this process.
        Protocol.clearCredential(request)
      } else if (controller.pending !== null) {
        // Closed before the answer arrived.
        controller.settle(null)
      }
    }

    parser: SplitParser {
      splitMarker: "\n"
      onRead: function (line) {
        var request = controller.pending
        if (request === null) return
        var result = Protocol.acceptResponse(request, controller.generation, line)
        if (!result.accepted) return
        controller.settle(result.response)
      }
    }
  }

  Connections {
    target: socket
    function onError() { controller.settle(null) }
  }

  // A daemon that accepts the connection and then says nothing must not wedge
  // the panel: bound the wait and settle as a transport failure.
  Timer {
    id: timeout
    interval: Protocol.REQUEST_TIMEOUT_MS
    repeat: false
    onTriggered: {
      Protocol.abortRequest(controller.pending, "timeout")
      controller.settle(null)
    }
  }

  Component.onDestruction: {
    Protocol.abortRequest(controller.pending, "destroyed")
    controller.pending = null
  }
}
