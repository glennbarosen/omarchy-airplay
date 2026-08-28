// Pure view-model helpers for the AIRPLAY section. No QML imports, mirroring
// the style of the panel's own Model.js so the transformations stay easy to
// inspect. Socket parsing and request validation live in Protocol.js.

// "AppleTV14,1" -> "Apple TV 4K". Falls back to the raw model string, which
// is still more informative than nothing for third-party receivers.
function friendlyModel(model) {
  var raw = String(model || "").trim()
  if (raw === "") return ""

  var appleTv = raw.match(/^AppleTV(\d+),(\d+)$/)
  if (appleTv) {
    var major = parseInt(appleTv[1], 10)
    if (major >= 11) return "Apple TV 4K"
    if (major === 6 || major === 5) return "Apple TV HD"
    return "Apple TV"
  }
  if (/^Mac/i.test(raw)) return "Mac"
  if (/^AudioAccessory/i.test(raw)) return "HomePod"
  return raw
}

// Fold the daemon's device list together with its active streams so each row
// carries everything a view needs without cross-referencing two arrays.
function mergeDevices(devices, streams) {
  var byIp = {}
  var list = streams || []
  for (var s = 0; s < list.length; s++) {
    var stream = list[s]
    if (stream && stream.device_ip) byIp[stream.device_ip] = stream
  }

  var rows = []
  var found = devices || []
  for (var d = 0; d < found.length; d++) {
    var device = found[d]
    if (!device || !device.ip) continue
    rows.push(rowFor(device.name, device.model, device.ip, device.port, byIp[device.ip], device.device_id))
    delete byIp[device.ip]
  }

  // A receiver we are streaming to that has aged out of the discovery cache
  // must still be listed — otherwise the only way to stop it disappears.
  for (var ip in byIp) {
    var orphan = byIp[ip]
    rows.push(rowFor(orphan.device, "", ip, 0, orphan, ""))
  }

  return rows
}

function rowFor(name, model, ip, port, stream, deviceId) {
  var state = stream ? String(stream.state || "") : "idle"
  return {
    name: String(name || ip || "Unknown"),
    model: friendlyModel(model),
    ip: String(ip || ""),
    port: Number(port || 0),
    deviceId: String(deviceId || ""),
    state: state,
    streaming: state === "streaming",
    connecting: state === "connecting" || state === "discovering",
    needsCredential: state === "pin_required",
    credentialKind: stream ? String(stream.credential_kind || "") : "",
    hasAudio: stream ? !!stream.has_audio : false,
    audioMuted: stream ? !!stream.audio_muted : false
  }
}

// Active receivers first so the thing you are most likely to want to stop is
// always the top row; everything else alphabetically, IP breaking ties.
function sortRows(rows) {
  var copy = (rows || []).slice()
  copy.sort(function (a, b) {
    var rankA = rowRank(a)
    var rankB = rowRank(b)
    if (rankA !== rankB) return rankA - rankB
    var nameA = a.name.toLowerCase()
    var nameB = b.name.toLowerCase()
    if (nameA !== nameB) return nameA < nameB ? -1 : 1
    return a.ip < b.ip ? -1 : (a.ip > b.ip ? 1 : 0)
  })
  return copy
}

function rowRank(row) {
  if (!row) return 3
  if (row.streaming) return 0
  if (row.connecting || row.needsCredential) return 1
  return 2
}

// The hero's all-caps status line, or "" to let the panel keep showing its
// own brightness label.
function heroMeta(rows) {
  var list = rows || []
  var streaming = []
  var connecting = false
  for (var i = 0; i < list.length; i++) {
    if (list[i].streaming) streaming.push(list[i].name)
    else if (list[i].connecting) connecting = true
  }
  if (streaming.length === 1) return ("Mirroring to " + streaming[0]).toUpperCase()
  if (streaming.length > 1) return ("Mirroring to " + streaming.length + " receivers").toUpperCase()
  if (connecting) return "CONNECTING…"
  return ""
}

// Second line of a device row. Empty collapses the row to a single line.
function rowStatus(row, busyKind) {
  if (!row) return ""
  if (busyKind === "connect") return "Connecting…"
  if (busyKind === "disconnect") return "Disconnecting…"
  if (row.streaming) return "Mirroring"
  if (row.connecting) return "Connecting…"
  if (row.needsCredential) return ""
  return row.model
}

function credentialPlaceholder(kind) {
  return kind === "password" ? "Receiver password" : "4-digit code from the TV"
}

function credentialIsValid(kind, value) {
  var text = String(value || "")
  if (kind === "password") return text.length > 0
  return /^\d{4}$/.test(text)
}
