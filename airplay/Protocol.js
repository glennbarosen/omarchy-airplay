// Wire protocol for doubletake's control socket, plus the two settings that
// reach the daemon's argv. Pure functions only, no QML imports — Controller.qml
// owns the Socket, the timer and the generation counter, and calls in here for
// every decision. Keeping the decisions here is what makes them testable under
// plain node (see tests/).
//
// PROTOCOL
// The daemon listens on a Unix socket and speaks one newline-terminated JSON
// object per request, answering with one newline-terminated JSON object. The
// request struct is exactly {cmd, target, port, pin}; `pin` carries both an
// on-screen PIN and a configured password, which is why it is the only field
// a credential is ever written into.

var SOCKET_NAME = "doubletake.sock"

// A request that gets no answer must not wedge the panel: the controller
// aborts and the next poll starts clean. Long enough for a daemon that is
// mid-connect, short enough that a dead socket is noticed within one poll.
var REQUEST_TIMEOUT_MS = 5000

// Every command the daemon dispatches. Anything else is refused before it can
// reach the socket.
var COMMANDS = [
  "status",
  "devices",
  "discover",
  "connect",
  "disconnect",
  "reset-restore-token",
  "mute",
  "unmute"
]

// Commands that address one receiver and are meaningless without it.
var TARGET_REQUIRED = ["reset-restore-token"]

var DEFAULT_PORT_RANGE = "60000-60010"
var HWACCELS = ["auto", "vaapi", "nvenc", "openh264", "none"]

// ------------------------------------------------------------------ socket path

// DoubleTake creates its control socket inside the current user's protected
// XDG runtime directory. Never fall back to a globally claimable /tmp path:
// connect requests may carry a receiver PIN or password.
function socketPaths(env) {
  var dir = ""
  if (env && typeof env === "object" && typeof env.XDG_RUNTIME_DIR === "string") {
    dir = env.XDG_RUNTIME_DIR.trim()
  }
  if (dir === "" || dir.charAt(0) !== "/") return []
  while (dir.length > 1 && dir.charAt(dir.length - 1) === "/") dir = dir.slice(0, -1)
  return [dir + "/" + SOCKET_NAME]
}

function socketPath(env) {
  return socketPaths(env)[0]
}

function fallbackSocketPath(paths, currentPath, payloadWritten) {
  if (payloadWritten || !Array.isArray(paths)) return ""
  var index = paths.indexOf(currentPath)
  if (index < 0 || index + 1 >= paths.length) return ""
  var candidate = paths[index + 1]
  return typeof candidate === "string" && candidate.charAt(0) === "/" ? candidate : ""
}

// The last gate before Socket.write(). A path that was never resolved and a
// line that is not exactly one terminated request both fail closed.
function canWrite(path, line) {
  if (typeof path !== "string" || path.trim() === "" || path.charAt(0) !== "/") return false
  if (path === "/tmp/" + SOCKET_NAME) return false
  if (typeof line !== "string" || line === "") return false
  if (line.charAt(line.length - 1) !== "\n") return false
  return line.indexOf("\n") === line.length - 1
}

// ----------------------------------------------------------- response validation

// One response object, or null. Null always means "no usable answer from the
// daemon" — a closed socket, a truncated read, a half-open connection — and is
// handled as a transport failure. A daemon that is alive and refusing always
// answers with a JSON object carrying a boolean `ok`, so anything without one
// is not an answer.
function parseResponse(text) {
  var raw = String(text === null || text === undefined ? "" : text).trim()
  if (raw === "") return null

  var parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  if (typeof parsed.ok !== "boolean") return null
  if (typeof parsed.state !== "string") return null
  if (parsed.error !== undefined && typeof parsed.error !== "string") return null
  if (parsed.devices !== undefined && !Array.isArray(parsed.devices)) return null
  if (parsed.streams !== undefined && !Array.isArray(parsed.streams)) return null
  if (parsed.devices !== undefined) {
    for (var d = 0; d < parsed.devices.length; d++) {
      var device = parsed.devices[d]
      if (!device || typeof device !== "object" || Array.isArray(device)) return null
      if (typeof device.name !== "string" || typeof device.ip !== "string") return null
      if (device.model !== undefined && typeof device.model !== "string") return null
      if (device.device_id !== undefined && typeof device.device_id !== "string") return null
      if (device.port !== undefined && typeof device.port !== "number") return null
    }
  }
  if (parsed.streams !== undefined) {
    for (var s = 0; s < parsed.streams.length; s++) {
      var stream = parsed.streams[s]
      if (!stream || typeof stream !== "object" || Array.isArray(stream)) return null
      if (typeof stream.device !== "string"
          || typeof stream.device_ip !== "string"
          || typeof stream.state !== "string") return null
      if (stream.credential_kind !== undefined
          && typeof stream.credential_kind !== "string") return null
      if (stream.error !== undefined && typeof stream.error !== "string") return null
    }
  }
  return parsed
}

// A panel refresh is a two-response transaction: a status snapshot and the
// device list that accompanies it. Returning one object here keeps QML from
// publishing either half until both validated replies are present.
function refreshSnapshot(status, devices) {
  if (!status || !devices || status.ok !== true || devices.ok !== true) return null
  if (status.streams !== undefined && !Array.isArray(status.streams)) return null
  if (devices.devices !== undefined && !Array.isArray(devices.devices)) return null
  return {
    streams: status.streams || [],
    devices: devices.devices || []
  }
}

// ---------------------------------------------------------- request construction

// Receiver addresses as doubletake discovers them: IPv4, IPv6, or an mDNS
// hostname. Deliberately narrow — the target is echoed into a JSON request and
// nothing else should ever be shaped like one.
function validTarget(target) {
  if (typeof target !== "string" || target === "" || target.length > 255) return false
  return /^[A-Za-z0-9._:-]+$/.test(target)
}

function validPort(port) {
  var value = typeof port === "string" && /^[0-9]+$/.test(port) ? Number(port) : port
  if (typeof value !== "number" || !isFinite(value)) return 0
  if (Math.floor(value) !== value) return 0
  if (value < 1 || value > 65535) return 0
  return value
}

// Builds one newline-terminated request, or null if it must not be sent.
// JSON.stringify is what makes a hostile credential inert: quotes, backslashes
// and newlines are escaped, so a typed PIN cannot close the object and append a
// second command.
function buildRequest(cmd, options) {
  if (typeof cmd !== "string" || COMMANDS.indexOf(cmd) < 0) return null

  var opts = options || {}
  var request = { cmd: cmd }

  var target = (typeof opts.target === "string") ? opts.target.trim() : ""
  if (target !== "") {
    if (!validTarget(target)) return null
    request.target = target
  } else if (TARGET_REQUIRED.indexOf(cmd) >= 0) {
    return null
  }

  if (cmd === "connect") {
    var port = validPort(opts.port)
    if (port > 0) request.port = port
    if (typeof opts.pin === "string" && opts.pin !== "") request.pin = opts.pin
  }

  return JSON.stringify(request) + "\n"
}

// -------------------------------------------------- generation guard and cleanup

// One in-flight request, stamped with the controller's generation. The built
// line is the only place a credential lives, and it is dropped the moment the
// request reaches any terminal state.
//
// This is scope, not zeroization: JavaScript strings are immutable and
// GC-managed, so dropping the reference is the strongest guarantee available
// here. The secret never reaches argv, a file or a log.
function beginRequest(generation, cmd, options) {
  var line = buildRequest(cmd, options)
  if (line === null) return null

  var opts = options || {}
  return {
    generation: generation,
    cmd: cmd,
    target: (typeof opts.target === "string") ? opts.target.trim() : "",
    submitted: typeof opts.pin === "string" && opts.pin !== "",
    line: line,
    done: false
  }
}

// Drops the credential-bearing line without ending the request. Called the
// moment the line has been written and flushed: from then on the request is
// still in flight, but this process no longer holds the secret.
function clearCredential(pending) {
  if (!pending) return
  pending.line = ""
}

// Clears the credential-bearing line and marks the request terminal. Every
// path out of an in-flight request goes through here.
function finishRequest(pending) {
  if (!pending) return
  pending.line = ""
  pending.done = true
}

function abortRequest(pending, reason) {
  finishRequest(pending)
  return reason
}

// Accepts a response only for the generation that asked for it, and only once.
// A stale generation means the panel moved on; a second read on the same
// request means the daemon said more than the one object it promised.
function acceptResponse(pending, generation, text) {
  if (!pending || pending.done || pending.generation !== generation) {
    return {
      accepted: false,
      response: null,
      transportFailed: false,
      failureKind: ""
    }
  }

  var response = parseResponse(text)
  finishRequest(pending)
  return {
    accepted: true,
    response: response,
    transportFailed: response === null,
    failureKind: response === null ? "malformedResponse" : ""
  }
}

// -------------------------------------------------------------- error reporting

function failureMessage(kind) {
  switch (kind) {
    case "socketUnavailable":
      return "The AirPlay service is unavailable."
    case "socketTimeout":
      return "The AirPlay service did not respond within five seconds."
    case "socketClosed":
      return "The AirPlay service closed the connection without a response."
    case "malformedResponse":
      return "The AirPlay service returned a malformed response."
    case "requestRejected":
      return "The AirPlay service rejected the request."
    case "discoveryReported":
      return "Receiver discovery reported a problem."
    case "streamReported":
      return "The mirroring stream reported a problem."
    default:
      return "The AirPlay service reported a problem."
  }
}

function responseFailure(cmd, response) {
  if (!response || typeof response !== "object") return ""
  if (response.ok !== true) {
    return (cmd === "devices" || cmd === "discover")
      ? "discoveryReported"
      : "requestRejected"
  }
  if (cmd === "status") {
    if (typeof response.error === "string" && response.error !== "") return "streamReported"
    var streams = response.streams || []
    for (var i = 0; i < streams.length; i++) {
      if (streams[i].state === "error"
          || (typeof streams[i].error === "string" && streams[i].error !== "")) {
        return "streamReported"
      }
    }
  }
  if ((cmd === "devices" || cmd === "discover")
      && typeof response.error === "string" && response.error !== "") {
    return "discoveryReported"
  }
  return ""
}

// A prior error remains until the complete status+devices transaction
// succeeds. A newer verified failure replaces it with its sanitized category.
function nextRefreshError(currentError, failureKind, complete) {
  if (failureKind) return failureMessage(failureKind)
  return complete ? "" : String(currentError || "")
}

// The daemon's own error strings can carry socket paths, credential files and
// whatever a receiver echoed back, so none of them reach the panel or a log.
// The user gets one short line naming the action that failed.
function sanitizeError(cmd, response, failureKind) {
  if (failureKind) return failureMessage(failureKind)
  if (response === null || response === undefined) {
    return failureMessage("socketClosed")
  }
  var reported = responseFailure(cmd, response)
  if (reported === "streamReported" || reported === "discoveryReported") {
    return failureMessage(reported)
  }
  switch (cmd) {
    case "connect":
      return "Could not start mirroring."
    case "disconnect":
      return "Could not stop mirroring."
    case "reset-restore-token":
      return "Could not re-pick the shared source."
    case "mute":
    case "unmute":
      return "Could not change the mirrored audio."
    default:
      return "The AirPlay service reported a problem."
  }
}

// --------------------------------------------------------------- poll scheduling

// The cadence documented in DESIGN.md section 6. Closed and idle means no
// timer at all, so an untouched desktop pays nothing for this widget.
function shouldPoll(state) {
  var s = state || {}
  return !!(s.open || s.mirroring)
}

function pollInterval(state) {
  var s = state || {}
  if (!s.open) return s.mirroring ? 10000 : 0
  return (s.settling || s.starting) ? 1000 : 3000
}

// ------------------------------------------------------- settings reaching argv

function validHwaccel(value) {
  if (typeof value !== "string") return "auto"
  return HWACCELS.indexOf(value) >= 0 ? value : "auto"
}

// Mirrors doubletake's validatePortRange: 1-65535, min <= max, and at least
// three consecutive UDP ports for the receiver's timing and audio channels.
// Anything the daemon would reject is refused here and replaced with the
// default, so the user's text can never become argv.
function parsePortRange(value) {
  var fallback = { min: 60000, max: 60010 }
  if (typeof value !== "string") return fallback

  var match = value.trim().match(/^([0-9]{1,5})-([0-9]{1,5})$/)
  if (!match) return fallback

  var min = Number(match[1])
  var max = Number(match[2])
  if (min < 1 || max > 65535 || min > max) return fallback
  if (max - min + 1 < 3) return fallback
  return { min: min, max: max }
}

// The flag is rebuilt from the two validated integers; the raw setting string
// is never forwarded.
function portRangeArgs(value) {
  var range = parsePortRange(value)
  return ["-port-range", range.min + "-" + range.max]
}

// The complete argv for the lazy daemon start. Both settings are whitelisted,
// no credential is ever part of it, and it is an argv rather than a shell
// string so nothing in it can be interpreted.
function daemonCommand(hwaccel, portRange) {
  return ["doubletake", "-daemonize", "-hwaccel", validHwaccel(hwaccel)]
    .concat(portRangeArgs(portRange))
}
