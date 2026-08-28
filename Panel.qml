import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Ui
import qs.Commons
import "airplay"
import "airplay/Model.js" as AirplayModel

// Standalone bar widget: a receiver list that mirrors this desktop over
// AirPlay. All of the behaviour lives in airplay/Section.qml; this file is
// just the bar button, the popup, and the keyboard cursor the section reads.
//
// HOSTING THE SECTION ELSEWHERE
// airplay/Section.qml is deliberately host-agnostic. It reads exactly the
// cursor surface every first-party Omarchy panel already exposes:
//
//   opened, cursorActive, focusSection, selectedIndex, reflowingText,
//   ensureCursorVisible(item)
//
// so it drops unchanged into a cloned omarchy.monitor ("Display") panel if you
// would rather have mirroring live there than in its own bar icon. See
// README.md, "Embedding in another panel".
Panel {
  id: root
  moduleName: "baro.airplay"
  ipcTarget: "baro.airplay"

  // ---- the cursor model Section.qml reads ----
  property string focusSection: "airplay"
  property int selectedIndex: 0
  property bool cursorActive: false
  // Only a text-size change reflows a panel hard enough to need this; nothing
  // here does, so it is a constant. It exists because the section reads it.
  readonly property bool reflowingText: false

  readonly property bool mirroring: airplaySection.mirroring

  function moveCursor(delta) {
    var max = airplaySection.rowCount - 1
    if (max < 0) return
    var next = selectedIndex + delta
    root.selectedIndex = next < 0 ? 0 : (next > max ? max : next)
  }

  function clampCursor() {
    var max = airplaySection.rowCount - 1
    if (selectedIndex > max) root.selectedIndex = max < 0 ? 0 : max
    if (selectedIndex < 0) root.selectedIndex = 0
  }

  function activateCursor() {
    airplaySection.activateRow(root.selectedIndex)
  }

  // Keep the focused row inside the viewport, mirroring the helper the
  // first-party panels use.
  function ensureCursorVisible(item) {
    if (!item || !scrollArea) return
    var flick = scrollArea.contentItem
    if (!flick || flick.contentY === undefined) return
    var pt = item.mapToItem(flick.contentItem || flick, 0, 0)
    var top = pt.y
    var bottom = top + (item.height || 0)
    var viewTop = flick.contentY
    var margin = 6
    if (top < viewTop + margin) flick.contentY = Math.max(0, top - margin)
    else if (bottom > viewTop + flick.height - margin) flick.contentY = bottom + margin - flick.height
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    root.focusSection = "airplay"
    root.selectedIndex = 0
    root.cursorActive = false
  }

  Connections {
    target: airplaySection
    function onRowCountChanged() { root.clampCursor() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // md-television (U+F0839). A filled badge rather than another outlined
    // rectangle, so it stays legible next to the Display widget at bar size.
    // Deliberately NOT md-monitor or md-monitor_multiple: the Display widget
    // owns both, swapping to monitor_multiple whenever a second screen is
    // attached. The receiver rows use this same glyph, matching how the
    // Bluetooth widget shares its glyph with its device rows.
    text: "󰠹"
    // WidgetButton.active paints with bar.urgent, so a live stream reads as a
    // state on the icon rather than a different icon appearing in the bar.
    active: root.mirroring
    tooltipText: root.mirroring
      ? AirplayModel.safeShellText(airplaySection.heroText)
      : "Screen Mirroring"
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(panelColumn.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: airplaySection.credentialIp !== ""
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      ScrollView {
        id: scrollArea
        anchors.fill: parent
        clip: true
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical.policy: panelColumn.implicitHeight > height ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
        Binding {
          target: scrollArea.contentItem
          property: "interactive"
          value: panelColumn.implicitHeight > scrollArea.height
        }

        Column {
          id: panelColumn
          width: scrollArea.availableWidth
          spacing: Style.space(14)

          PanelHero {
            title: "Screen Mirroring"
            meta: airplaySection.heroText !== ""
              ? AirplayModel.safeShellText(airplaySection.heroText)
              : "Not mirroring"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily

            iconComponent: Text {
              text: "󰠹"
              textFormat: Text.PlainText
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.display
            }

            trailingControl: ToggleSwitch {
              visible: airplaySection.mirroring || airplaySection.settling
              checked: airplaySection.mirroring
              busy: airplaySection.settling
              foreground: root.bar.foreground
              onToggled: airplaySection.disconnectAll()
            }
          }

          Section {
            id: airplaySection
            width: parent.width
            panel: root
            bar: root.bar
          }

          Item {
            width: parent.width
            height: Style.space(4)
          }
        }
      }
    }
  }
}
