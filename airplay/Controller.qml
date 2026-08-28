pragma ComponentBehavior: Bound

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
  signal answered(string cmd, string target, var response, string failureKind, bool submitted)

  readonly property bool busy: pending !== null

  // Production uses only the current user's protected XDG runtime socket.
  // Tests may supply two isolated absolute paths to exercise transport retry.
  property var socketPathsOverride: null
  readonly property var paths: socketPathsOverride !== null
    ? socketPathsOverride
    : Protocol.socketPaths({
        XDG_RUNTIME_DIR: String(Quickshell.env("XDG_RUNTIME_DIR") || "")
      })
  readonly property string path: paths.length > 0 ? paths[0] : ""

  property var pending: null
  property var queuedInteractive: null
  property int generation: 0
  property var transport: null

  function requestForGeneration(expectedGeneration) {
    var request = controller.pending
    return request !== null && request.generation === expectedGeneration ? request : null
  }

  // Sends one command. Returns false when the request was refused before it
  // could be written — an unknown command, a malformed target, a path that did
  // not resolve, or a request already in flight.
  function send(cmd, options) {
    controller.generation += 1
    var request = Protocol.beginRequest(controller.generation, cmd, options)
    if (request === null) return false
    request.socketPaths = Array.prototype.slice.call(controller.paths)
    request.socketPath = request.socketPaths.length > 0 ? request.socketPaths[0] : ""
    request.payloadWritten = false
    request.interactive = !!(options && options.interactive === true)
    if (!Protocol.canWrite(request.socketPath, request.line)) return false

    if (controller.pending !== null) {
      if (!request.interactive
          || controller.pending.interactive === true
          || controller.queuedInteractive !== null) {
        Protocol.finishRequest(request)
        return false
      }
      controller.queuedInteractive = request
      return true
    }

    controller.startRequest(request)
    return true
  }

  function startRequest(request) {
    controller.pending = request
    timeout.restart()
    controller.openTransport(request)
  }

  function openTransport(request) {
    var candidate = socketComponent.createObject(controller, {
      path: request.socketPath,
      requestGeneration: request.generation
    })
    controller.transport = candidate
    Qt.callLater(function () {
      if (controller.requestForGeneration(request.generation) === null
          || controller.transport !== candidate) return
      candidate.started = true
      candidate.connected = true
    })
  }

  function retryFallback(expectedGeneration, failedTransport) {
    var request = controller.requestForGeneration(expectedGeneration)
    if (request === null || controller.transport !== failedTransport) return false
    var fallback = Protocol.fallbackSocketPath(
      request.socketPaths, request.socketPath, request.payloadWritten
    )
    if (fallback === "" || !Protocol.canWrite(fallback, request.line)) return false

    controller.transport = null
    failedTransport.started = false
    failedTransport.connected = false
    failedTransport.destroy()
    request.socketPath = fallback
    controller.openTransport(request)
    return true
  }

  // The single exit. Whatever happened, the credential-bearing line is dropped
  // here, the socket is closed, and the result is reported exactly once.
  function settle(response, failureKind) {
    var request = controller.pending
    if (request === null) return

    var cmd = request.cmd
    var target = request.target
    var submitted = request.submitted
    Protocol.finishRequest(request)
    controller.pending = null

    timeout.stop()
    var finishedTransport = controller.transport
    controller.transport = null
    if (finishedTransport !== null) {
      finishedTransport.connected = false
      finishedTransport.destroy()
    }

    var queued = controller.queuedInteractive
    controller.queuedInteractive = null
    if (queued !== null) controller.startRequest(queued)
    controller.answered(cmd, target, response, String(failureKind || ""), submitted)
  }

  function settleForGeneration(expectedGeneration, response, failureKind) {
    if (controller.requestForGeneration(expectedGeneration) === null) return
    controller.settle(response, failureKind)
  }

  // Quickshell 0.3.x retains a failed QLocalSocket after an initial
  // ServerNotFoundError, and its public properties cannot make that wrapper
  // reconnect. A fresh transport per request also matches doubletake's
  // one-request-per-connection protocol and makes every terminal path dispose
  // the poisoned native socket rather than carrying it into later work.
  Component {
    id: socketComponent

    Item {
      id: requestTransport
      visible: false

      property alias path: socket.path
      property alias connected: socket.connected
      property int requestGeneration: -1
      property bool started: false

      Socket {
        id: socket

        onConnectionStateChanged: {
          if (controller.transport !== requestTransport) {
            if (connected) socket.connected = false
            return
          }
          if (connected) {
            var request = controller.requestForGeneration(requestTransport.requestGeneration)
            if (request === null || request.done) {
              socket.connected = false
              return
            }
            request.payloadWritten = true
            // Written and flushed in the same turn: the daemon reads one line and
            // will not answer until it has one.
            socket.write(request.line)
            socket.flush()
            // The line was the only copy of the credential; the request stays in
            // flight but the secret is gone from this process.
            Protocol.clearCredential(request)
          } else if (requestTransport.started) {
            if (controller.retryFallback(
                requestTransport.requestGeneration, requestTransport)) return
            var request = controller.requestForGeneration(requestTransport.requestGeneration)
            var failureKind = request !== null && request.payloadWritten
              ? "socketClosed"
              : "socketUnavailable"
            controller.settleForGeneration(
              requestTransport.requestGeneration, null, failureKind
            )
          }
        }

        parser: SplitParser {
          splitMarker: "\n"
          onRead: function (line) {
            if (controller.transport !== requestTransport) return
            var request = controller.requestForGeneration(requestTransport.requestGeneration)
            if (request === null) return
            var result = Protocol.acceptResponse(
              request, requestTransport.requestGeneration, line
            )
            if (!result.accepted) return
            controller.settleForGeneration(
              requestTransport.requestGeneration, result.response, result.failureKind
            )
          }
        }
      }

      Connections {
        target: socket
        function onError() {
          if (controller.transport !== requestTransport) return
          if (controller.retryFallback(
              requestTransport.requestGeneration, requestTransport)) return
          var request = controller.requestForGeneration(requestTransport.requestGeneration)
          var failureKind = request !== null && request.payloadWritten
            ? "socketClosed"
            : "socketUnavailable"
          controller.settleForGeneration(
            requestTransport.requestGeneration, null, failureKind
          )
        }
      }
    }
  }

  // A daemon that accepts the connection and then says nothing must not wedge
  // the panel: bound the wait and settle as a transport failure.
  Timer {
    id: timeout
    interval: Protocol.REQUEST_TIMEOUT_MS
    repeat: false
    onTriggered: {
      Protocol.abortRequest(controller.pending, "timeout")
      controller.settle(null, "socketTimeout")
    }
  }

  Component.onDestruction: {
    Protocol.abortRequest(controller.pending, "destroyed")
    Protocol.abortRequest(controller.queuedInteractive, "destroyed")
    controller.pending = null
    controller.queuedInteractive = null
    if (controller.transport !== null) {
      controller.transport.connected = false
      controller.transport.destroy()
      controller.transport = null
    }
  }
}
