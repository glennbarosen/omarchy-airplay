import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Airplay

// The AIRPLAY block of the Display panel: receiver list, connect/disconnect,
// and an inline PIN/password prompt. Everything talks to the doubletake
// daemon through `doubletake-ctl`, which answers one JSON object per
// invocation on stdout — so each command is a plain Process + StdioCollector,
// the same shape the panel already uses for omarchy-monitor-state.
//
// The panel that hosts this section owns the shared keyboard cursor
// (cursorActive / focusSection / selectedIndex); rows only read it, exactly
// as CursorSurface requires. Hand it in via `panel`.
Column {
  id: section

  property QtObject panel: null
  property QtObject bar: null

  // ---- backend availability ----
  property bool probed: false
  property bool available: false
  property bool daemonUp: false
  property bool daemonStarting: false
  property bool daemonFailed: false
  property int daemonAttempts: 0

  // ---- daemon state ----
  property var devices: []
  property var streams: []
  property var rows: []
  property bool discovering: false
  property string errorText: ""

  // Which row has its ⋯ menu expanded. Only one at a time.
  property string menuIp: ""

  // ---- inline credential prompt ----
  property string credentialIp: ""
  property string credentialKind: "pin"
  property string credentialText: ""
  property bool credentialRejected: false
  property bool credentialSubmitted: false

  // ---- in-flight action ----
  property string busyIp: ""
  property string busyKind: ""

  readonly property int rowCount: rows.length
  readonly property bool mirroring: {
    for (var i = 0; i < rows.length; i++) if (rows[i].streaming) return true
    return false
  }
  readonly property bool settling: {
    if (busyIp !== "") return true
    for (var i = 0; i < rows.length; i++) if (rows[i].connecting) return true
    return false
  }
  readonly property string heroText: Airplay.heroMeta(rows)

  // H.264 encoder handed to doubletake when this plugin starts it. Read from
  // the widget's shell.json entry and whitelisted before it reaches argv,
  // because "auto" is wrong often enough to be worth exposing but this value
  // must never be free-form. Hosts that expose no settings get "auto".
  readonly property string hwaccel: {
    var raw = (panel && typeof panel.setting === "function") ? String(panel.setting("hwaccel", "auto")) : "auto"
    var allowed = ["auto", "vaapi", "nvenc", "openh264", "none"]
    return allowed.indexOf(raw) >= 0 ? raw : "auto"
  }
  readonly property bool panelOpen: panel ? panel.opened : false

  // Right-aligned caption beside the section header.
  readonly property string headerNote: {
    if (!available) return ""
    if (daemonStarting) return "Starting…"
    return ""
  }

  // The one explanatory line shown in place of (or under) the device list.
  readonly property string emptyText: {
    if (!probed) return ""
    if (!available) return "AirPlay mirroring needs doubletake.\nomarchy pkg aur add doubletake-bin"
    if (errorText !== "") return errorText
    if (!daemonUp) return daemonStarting ? "Starting the AirPlay service…" : "The AirPlay service is not running."
    if (rows.length === 0) return discovering ? "Looking for receivers…" : "No AirPlay receivers found."
    return ""
  }

  spacing: Style.space(14)
  visible: probed

  // ---------------------------------------------------------------- actions

  function rebuild() {
    section.rows = Airplay.sortRows(Airplay.mergeDevices(section.devices, section.streams))
  }

  function refresh() {
    if (!probed) {
      if (!probeProc.running) probeProc.running = true
      return
    }
    if (!available) return
    if (!statusProc.running) statusProc.running = true
  }

  // The daemon is started lazily, on the first open that needs it, so nothing
  // runs in the background until you actually reach for mirroring.
  function ensureDaemon() {
    if (!available || daemonStarting || daemonFailed || !panelOpen) return
    // reshare.sh stops and restarts the daemon itself; spawning a second one
    // underneath it would fight for the socket.
    if (actionProc.running) return
    section.errorText = ""
    section.daemonAttempts = 0
    section.daemonStarting = true
    Quickshell.execDetached(["doubletake", "-daemonize", "-hwaccel", section.hwaccel])
  }

  function discover() {
    if (!available || !daemonUp || discoverProc.running) return
    section.discovering = true
    discoverProc.running = true
  }

  function connectTo(ip, code) {
    if (!available || ip === "" || actionProc.running) return
    section.errorText = ""
    section.busyIp = ip
    section.busyKind = "connect"
    var cmd = ["doubletake-ctl", "connect", ip]
    if (code && String(code).length > 0) {
      cmd.push(String(code))
      section.credentialSubmitted = true
    }
    actionProc.command = cmd
    actionProc.running = true
  }

  function disconnectFrom(ip) {
    if (!available || actionProc.running) return
    section.errorText = ""
    section.busyIp = ip
    section.busyKind = "disconnect"
    actionProc.command = ip === "" ? ["doubletake-ctl", "disconnect"] : ["doubletake-ctl", "disconnect", ip]
    actionProc.running = true
  }

  function disconnectAll() {
    if (!available || actionProc.running) return
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].streaming) { section.busyIp = rows[i].ip; break }
    }
    section.errorText = ""
    section.busyKind = "disconnect"
    actionProc.command = ["doubletake-ctl", "disconnect"]
    actionProc.running = true
  }

  function openCredentialPrompt(ip, kind) {
    if (section.credentialIp !== ip) section.credentialText = ""
    section.credentialIp = ip
    section.credentialKind = (kind === "password") ? "password" : "pin"
    section.credentialRejected = false
    section.credentialSubmitted = false
  }

  function closeCredentialPrompt() {
    section.credentialIp = ""
    section.credentialText = ""
    section.credentialRejected = false
    section.credentialSubmitted = false
  }

  function submitCredential() {
    if (credentialIp === "") return
    if (!Airplay.credentialIsValid(credentialKind, credentialText)) return
    section.credentialRejected = false
    connectTo(credentialIp, credentialText)
  }

  function toggleMenu(ip) {
    if (section.menuIp === ip) { section.menuIp = ""; return }
    section.closeCredentialPrompt()
    section.menuIp = ip
  }

  function setMuted(ip, muted) {
    if (!available || actionProc.running) return
    section.busyIp = ip
    section.busyKind = "mute"
    actionProc.command = ["doubletake-ctl", muted ? "mute" : "unmute", ip]
    actionProc.running = true
  }

  // doubletake has no runtime "change source" command — the portal picks the
  // source once per session and the saved restore token makes every later
  // connect reuse it silently. reshare.sh forgets just that token and cycles
  // the daemon, which brings the portal's picker back.
  function reshare(ip, deviceId) {
    if (!available || actionProc.running) return
    if (deviceId === "") {
      section.errorText = "This receiver has no saved pairing to re-share from."
      return
    }
    section.menuIp = ""
    section.errorText = ""
    section.busyIp = ip
    section.busyKind = "connect"
    actionProc.command = [section.helperPath("reshare.sh"), deviceId, ip, section.hwaccel]
    actionProc.running = true
  }

  function helperPath(name) {
    return String(Qt.resolvedUrl(name)).replace(/^file:\/\//, "")
  }

  // Enter / click on a row. One target, one meaning: toggle this receiver.
  function activateRow(index) {
    if (index < 0 || index >= rows.length) return
    var row = rows[index]
    if (section.credentialIp === row.ip) { submitCredential(); return }
    if (row.streaming) { disconnectFrom(row.ip); return }
    if (row.needsCredential) { openCredentialPrompt(row.ip, row.credentialKind); return }
    connectTo(row.ip, "")
  }

  onPanelOpenChanged: {
    if (panelOpen) {
      section.daemonAttempts = 0
      section.daemonFailed = false
      // Re-probe while the backend is missing, so installing doubletake takes
      // effect on the next open instead of needing a shell restart. Once it is
      // found the probe never runs again.
      if (!available) section.probed = false
      refresh()
      if (available && daemonUp) discover()
    } else {
      closeCredentialPrompt()
      section.menuIp = ""
    }
  }

  Component.onCompleted: refresh()

  // --------------------------------------------------------------- backend

  Process {
    id: probeProc
    command: ["sh", "-c", "command -v doubletake-ctl >/dev/null && command -v doubletake >/dev/null && echo yes"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        section.available = String(text || "").trim() === "yes"
        section.probed = true
        if (section.available) section.refresh()
      }
    }
  }

  Process {
    id: statusProc
    command: ["doubletake-ctl", "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var resp = Airplay.parseResponse(text)
        if (!resp) {
          // An action in flight may be cycling the daemon on purpose; leave
          // the UI alone rather than flashing "service not running".
          if (actionProc.running) return
          // No parseable answer means no daemon on the socket. Everything
          // else the daemon reports comes back as JSON, ok:false included.
          section.daemonUp = false
          section.streams = []
          section.rebuild()
          if (section.daemonStarting) {
            // Still waiting on the daemon we just spawned. Give it a few
            // seconds of polling before admitting it isn't coming up.
            section.daemonAttempts += 1
            if (section.daemonAttempts >= 12) {
              section.daemonStarting = false
              section.daemonFailed = true
              section.errorText = "Could not start the AirPlay service. Try running `doubletake -daemonize` in a terminal."
            }
          } else {
            section.ensureDaemon()
          }
          return
        }
        section.daemonUp = true
        section.daemonStarting = false
        section.daemonFailed = false
        section.daemonAttempts = 0
        section.streams = resp.streams || []
        section.rebuild()
        if (!devicesProc.running) devicesProc.running = true

        // A receiver that is waiting on a code opens the prompt on its own,
        // so a connect started outside this panel still finishes here.
        for (var i = 0; i < section.rows.length; i++) {
          var row = section.rows[i]
          if (row.needsCredential && section.credentialIp === "") {
            section.openCredentialPrompt(row.ip, row.credentialKind)
            break
          }
        }
      }
    }
  }

  Process {
    id: devicesProc
    command: ["doubletake-ctl", "devices"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var resp = Airplay.parseResponse(text)
        if (!resp) return
        section.devices = resp.devices || []
        section.rebuild()
      }
    }
  }

  Process {
    id: discoverProc
    command: ["doubletake-ctl", "discover"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        section.discovering = false
        var resp = Airplay.parseResponse(text)
        if (!resp) return
        if (resp.devices) section.devices = resp.devices
        if (resp.streams) section.streams = resp.streams
        section.rebuild()
      }
    }
  }

  Process {
    id: actionProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var target = section.busyIp
        var kind = section.busyKind
        var submitted = section.credentialSubmitted
        section.busyIp = ""
        section.busyKind = ""
        section.credentialSubmitted = false

        var resp = Airplay.parseResponse(text)
        if (!resp) {
          section.daemonUp = false
          section.errorText = "The AirPlay service stopped responding."
          section.refresh()
          return
        }

        if (resp.needs_credential || resp.needs_pin) {
          // Coming back asking again right after we sent something means the
          // code was wrong — say so instead of silently re-prompting.
          section.credentialRejected = submitted
          section.openCredentialPrompt(target, resp.credential_kind || section.credentialKind)
          if (submitted) {
            section.credentialRejected = true
            section.credentialText = ""
          }
        } else if (!resp.ok) {
          section.errorText = String(resp.error || (kind === "connect" ? "Could not start mirroring." : "Could not stop mirroring."))
          if (section.credentialIp === target) section.closeCredentialPrompt()
        } else if (kind === "connect") {
          section.closeCredentialPrompt()
        }

        section.refresh()
      }
    }
  }

  // Poll while the panel is open, faster while something is in flight. When
  // the panel is closed we only keep watching if a stream is live, so the bar
  // glyph stays truthful without a subprocess ticking away on an idle desktop.
  Timer {
    interval: section.panelOpen ? (section.settling || section.daemonStarting ? 1000 : 3000) : 10000
    running: section.available && (section.panelOpen || section.mirroring)
    repeat: true
    onTriggered: section.refresh()
  }

  // ------------------------------------------------------------------- view

  PanelSeparator {
    foreground: section.bar.foreground
  }

  Column {
    width: parent.width
    spacing: Style.space(10)

    Item {
      width: parent.width
      implicitHeight: Math.max(airplayHeader.implicitHeight, airplayNote.implicitHeight, rescanButton.implicitHeight)

      PanelSectionHeader {
        id: airplayHeader
        text: "AIRPLAY"
        foreground: section.bar.foreground
        fontFamily: section.bar.fontFamily
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
      }

      // Same refresh glyph the Omarchy update widget uses, spinning while a
      // scan is in flight — subtler than a labelled button and it doubles as
      // the progress indicator.
      Button {
        id: rescanButton
        visible: section.available && section.daemonUp
        iconText: "\uf021"
        iconSize: Style.font.caption
        iconSpinning: section.discovering
        tooltipText: "Scan for receivers"
        foreground: section.bar.foreground
        fontFamily: section.bar.fontFamily
        horizontalPadding: Style.space(5)
        verticalPadding: Style.space(2)
        enabled: !section.discovering
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        onClicked: section.discover()
      }

      Text {
        id: airplayNote
        text: section.headerNote
        visible: text !== ""
        color: Qt.darker(section.bar.foreground, 1.4)
        font.family: section.bar.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
        anchors.right: rescanButton.visible ? rescanButton.left : parent.right
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Text {
      visible: section.emptyText !== ""
      width: parent.width - Style.space(12)
      x: Style.space(6)
      text: section.emptyText
      color: section.errorText !== "" ? section.bar.urgent : Qt.darker(section.bar.foreground, 1.5)
      font.family: section.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Repeater {
      model: section.rows

      DeviceRow {
        required property var modelData
        required property int index

        width: section.width
        row: modelData
        rowIndex: index
      }
    }

  }

  // ------------------------------------------------------------------- rows

  component DeviceRow: CursorSurface {
    id: deviceRow
    required property var row
    required property int rowIndex

    readonly property bool isSelected: section.panel
      && section.panel.focusSection === "airplay"
      && section.panel.selectedIndex === rowIndex
    readonly property bool isBusy: section.busyIp === row.ip && section.busyKind !== ""
    readonly property bool promptOpen: section.credentialIp === row.ip
    readonly property bool menuOpen: section.menuIp === row.ip
    readonly property bool actionsVisible: row.streaming && !isBusy
      && (rowMouse.containsMouse || menuOpen || (hasCursor && section.panel.cursorActive))
    readonly property string statusText: Airplay.rowStatus(row, isBusy ? section.busyKind : "")
    // Bluetooth's convention: the row's own colour carries the state, so no
    // separate red/green status icon is needed.
    readonly property color statusColor: (row.streaming || row.connecting || isBusy)
      ? section.bar.foreground
      : Qt.darker(section.bar.foreground, 1.5)

    hasCursor: section.panel && section.panel.cursorActive && isSelected
    onHasCursorChanged: if (hasCursor && section.panel) section.panel.ensureCursorVisible(deviceRow)
    current: row.streaming
    foreground: section.bar.foreground
    fill: Style.hoverFillFor(section.bar.foreground, Color.accent)
    currentFill: Style.selectedFillFor(section.bar.foreground, Color.accent)
    implicitHeight: rowBody.implicitHeight
      + (promptOpen ? credentialPanel.implicitHeight + Style.spacing.md : 0)
      + (menuOpen ? menuPanel.implicitHeight + Style.spacing.md : 0)

    MouseArea {
      id: rowMouse
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      height: rowBody.implicitHeight
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      enabled: !deviceRow.isBusy

      PanelToolTip {
        visible: rowMouse.containsMouse && !deviceRow.promptOpen
        text: deviceRow.row.streaming ? "Stop mirroring" : "Mirror to " + deviceRow.row.name
        fontFamily: section.bar.fontFamily
      }

      onContainsMouseChanged: if (containsMouse && section.panel && !section.panel.reflowingText) {
        section.panel.cursorActive = true
        section.panel.focusSection = "airplay"
        section.panel.selectedIndex = deviceRow.rowIndex
      }

      onClicked: {
        if (section.panel) {
          section.panel.cursorActive = true
          section.panel.focusSection = "airplay"
          section.panel.selectedIndex = deviceRow.rowIndex
        }
        section.activateRow(deviceRow.rowIndex)
      }
    }

    Item {
      id: rowBody
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.leftMargin: Style.space(6)
      anchors.rightMargin: Style.space(12)
      implicitHeight: Math.max(deviceIcon.implicitHeight, deviceLabels.implicitHeight) + Style.spacing.xl

      Text {
        id: deviceIcon
        text: "󰠹"
        color: deviceRow.statusColor
        font.family: section.bar.fontFamily
        font.pixelSize: Style.font.title
        width: Style.space(22)
        horizontalAlignment: Text.AlignHCenter
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
      }

      // Indicative only — the whole row is the click target, the way the
      // DISPLAYS rows above work. Turning red under the pointer is the hint
      // that clicking a mirroring receiver stops it.
      // Right slot, same shape as the Wi-Fi rows': a plain state glyph most
      // of the time, giving way to an action affordance under the pointer.
      // The check is the DISPLAYS rows' check — no colour coding.
      Item {
        id: rowState
        width: Style.space(22)
        implicitHeight: Math.max(stateGlyph.implicitHeight, menuButton.implicitHeight)
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter

        Text {
          id: stateGlyph
          visible: !menuButton.visible
          width: parent.width
          text: deviceRow.row.streaming && !deviceRow.isBusy ? "󰄬" : ""
          color: section.bar.foreground
          font.family: section.bar.fontFamily
          font.pixelSize: Style.font.subtitle
          horizontalAlignment: Text.AlignRight
          anchors.verticalCenter: parent.verticalCenter
        }

        PanelActionButton {
          id: menuButton
          visible: deviceRow.actionsVisible
          anchors.centerIn: parent
          iconText: "󰇘"
          tooltipText: deviceRow.menuOpen ? "Close" : "More options"
          foreground: section.bar.foreground
          fontFamily: section.bar.fontFamily
          bordered: deviceRow.menuOpen
          onClicked: section.toggleMenu(deviceRow.row.ip)
        }
      }

      Column {
        id: deviceLabels
        spacing: Style.space(1)
        anchors.left: deviceIcon.right
        anchors.leftMargin: Style.space(8)
        anchors.right: rowState.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter

        Text {
          text: deviceRow.row.name
          color: section.bar.foreground
          font.family: section.bar.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
          width: parent.width
        }

        Text {
          text: deviceRow.promptOpen ? "" : deviceRow.statusText
          visible: text !== ""
          height: visible ? implicitHeight : 0
          color: deviceRow.statusColor
          font.family: section.bar.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          width: parent.width
        }
      }
    }

    // The ⋯ strip. Everything doubletake can actually change on a live
    // stream, plus the source re-pick that needs the portal.
    Item {
      id: menuPanel
      visible: deviceRow.menuOpen
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: rowMouse.bottom
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(12)
      anchors.topMargin: Style.space(4)
      implicitHeight: menuRow.implicitHeight + Style.spacing.rowGap
      height: implicitHeight

      Row {
        id: menuRow
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.spacing.xs

        Button {
          text: "Source"
          iconText: "󰓡"
          tooltipText: "Mirror a different screen or window"
          fontSize: Style.font.caption
          iconSize: Style.font.caption
          foreground: section.bar.foreground
          fontFamily: section.bar.fontFamily
          horizontalPadding: Style.spacing.sm
          verticalPadding: Style.spacing.controlPaddingY
          bordered: true
          onClicked: section.reshare(deviceRow.row.ip, deviceRow.row.deviceId)
        }

        Button {
          visible: deviceRow.row.hasAudio
          text: deviceRow.row.audioMuted ? "Unmute" : "Mute"
          iconText: deviceRow.row.audioMuted ? "󰝟" : "󰕾"
          tooltipText: deviceRow.row.audioMuted ? "Send audio again" : "Mirror without audio"
          fontSize: Style.font.caption
          iconSize: Style.font.caption
          foreground: section.bar.foreground
          fontFamily: section.bar.fontFamily
          horizontalPadding: Style.spacing.sm
          verticalPadding: Style.spacing.controlPaddingY
          bordered: true
          active: deviceRow.row.audioMuted
          onClicked: section.setMuted(deviceRow.row.ip, !deviceRow.row.audioMuted)
        }

        Button {
          text: "Stop"
          iconText: "󰅙"
          tooltipText: "Stop mirroring to " + deviceRow.row.name
          fontSize: Style.font.caption
          iconSize: Style.font.caption
          foreground: section.bar.foreground
          fontFamily: section.bar.fontFamily
          horizontalPadding: Style.spacing.sm
          verticalPadding: Style.spacing.controlPaddingY
          bordered: true
          onClicked: { section.menuIp = ""; section.disconnectFrom(deviceRow.row.ip) }
        }
      }
    }

    // Inline pairing prompt. First connection to a receiver shows a 4-digit
    // code on the TV; receivers with "Require Password" set want that instead.
    Item {
      id: credentialPanel
      visible: deviceRow.promptOpen
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: deviceRow.menuOpen ? menuPanel.bottom : rowMouse.bottom
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(12)
      anchors.topMargin: Style.space(4)
      implicitHeight: codeField.implicitHeight + Style.spacing.rowGap
      height: implicitHeight

      TextField {
        id: codeField
        visible: !deviceRow.isBusy
        anchors.left: parent.left
        anchors.right: submitButton.left
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        password: section.credentialKind === "password"
        placeholderText: section.credentialRejected
          ? (section.credentialKind === "password" ? "Wrong password — try again" : "Wrong code — try again")
          : Airplay.credentialPlaceholder(section.credentialKind)
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        foreground: section.credentialRejected ? section.bar.urgent : section.bar.foreground
        horizontalPadding: Style.spacing.controlGap
        verticalPadding: Style.spacing.controlPaddingY
        enabled: !deviceRow.isBusy
        text: deviceRow.promptOpen ? section.credentialText : ""

        onAccepted: section.submitCredential()
        onTextChanged: if (deviceRow.promptOpen && text !== section.credentialText) section.credentialText = text
        Keys.onEscapePressed: section.closeCredentialPrompt()

        onVisibleChanged: if (visible) Qt.callLater(forceActiveFocus)
        Component.onCompleted: if (visible) Qt.callLater(forceActiveFocus)
      }

      BorderSurface {
        visible: deviceRow.isBusy
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        height: Style.spacing.controlHeight
        color: Style.normalFillFor(section.bar.foreground)
        borderSpec: Border.controlSpec("normal", section.bar.foreground, Color.accent)
        radius: Style.cornerRadius

        Text {
          anchors.fill: parent
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
          text: "Pairing…"
          color: section.bar.foreground
          font.family: section.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      PanelActionButton {
        id: submitButton
        visible: !deviceRow.isBusy
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        enabled: Airplay.credentialIsValid(section.credentialKind, section.credentialText)
        iconText: "󰄬"
        tooltipText: "Pair and mirror"
        foreground: section.bar.foreground
        fontFamily: section.bar.fontFamily
        onClicked: section.submitCredential()
      }
    }
  }
}
