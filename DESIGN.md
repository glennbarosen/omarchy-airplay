# Screen Mirroring (baro.airplay) Design System

Extracted from the shipped surface, not invented for it. This plugin renders
inside the long-lived `omarchy-shell` Quickshell process and owns **no palette,
no type scale, and no spacing scale of its own**: every value below resolves at
runtime from Omarchy's `qs.Commons` singletons (`Color`, `Style`, `Border`) and
its `qs.Ui` primitives, which in turn read the user's active theme
(`theme/colors.toml`, `theme/shell.toml`) and Hyprland's `decoration:rounding`
and `general:gaps_out`.

The rule that follows from that: **a literal color, font size, or pixel gap in
this plugin is a bug.** Tokens are the only legal source. Sections 2-4 document
the token surface this plugin is allowed to consume; Sections 5-7 document the
component anatomy, states, and motion already shipped in `airplay/Section.qml`
and `Panel.qml`.

Scope note: this contract records the *current* user-facing surface so that a
backend transport change (subprocess control → Unix-socket control) can be
verified as visually inert. The visual block of `airplay/Section.qml` is frozen
by this document; no new visual primitive is introduced.

---

## 1. Atmosphere & Identity

A terminal-native control strip that behaves like Control Center but dresses
like the user's terminal. It is monospaced, flat, and quiet: no shadow, no
gradient, no brand color of its own. Weight is carried by *tint and rank*, not
chrome — a receiver you are mirroring to sits at the top of the list, draws the
full-strength foreground, and shows a check; everything idle recedes to a
darkened foreground and reads as a supporting line.

The signature is **theme dissolution**. The panel has no identity that survives
a theme switch: change the Omarchy theme and this widget becomes that theme,
because every surface is an alpha of `Color.foreground` / `Color.accent` /
`Color.urgent` rather than a color of its own. The AirPlay-ness is carried
entirely by one Nerd Font glyph (`󰠹`, md-television) reused at three sizes —
bar icon, hero icon, row icon — which is also why the widget never ships a
raster asset.

---

## 2. Color

No hex value is declared in this plugin. All roles resolve through the injected
`bar` object (`bar.foreground`, `bar.urgent`, `bar.fontFamily`) and the
`Color` / `Style` singletons.

### Palette

| Role | Token in this plugin | Resolves to | Usage |
|---|---|---|---|
| Text/primary | `section.bar.foreground` | `Color.bar.text` → `Color.foreground` (theme; default `#cacccc`) | Device names, hero title, active row icon/label, check glyph, menu buttons |
| Text/secondary | `Qt.darker(bar.foreground, 1.4)` | derived | Header note ("Starting…") beside the section header |
| Text/tertiary | `Qt.darker(bar.foreground, 1.5)` | derived | Idle row status line, idle row icon, empty-state copy |
| Text/disabled | `Qt.darker(foreground, 2.0)` | derived, owned by `PanelActionButton` | Disabled submit button glyph |
| Status/error | `section.bar.urgent` | `Color.bar.active` → `Color.urgent` (theme; default `#a55555`) | Error line in the empty-state slot, rejected-credential placeholder + field text |
| Accent | `Color.accent` | theme (default tracks foreground) | Passed to `Style.*For()` state helpers for row fill/border resolution |
| Surface/background | — | Owned by `KeyboardPanel` / `PopupCard`, not by this plugin | Panel backdrop |
| State/hover-cursor fill | `Style.hoverFillFor(fg, Color.accent)` | `alpha(hoverStateColor, 0.08)` | Row under keyboard cursor or pointer |
| State/selected fill | `Style.selectedFillFor(fg, Color.accent)` | `alpha(selectedStateColor, 0.18)` | Row currently mirroring (`current: true`) |
| State/normal fill | `Style.normalFillFor(fg)` | `alpha(normalStateColor, 0.04)` | "Pairing…" busy plate inside the credential slot |
| Border/normal | `Border.controlSpec("normal", fg, accent)` | `alpha(color, 0.4)`, width 1 | Busy plate outline, bordered menu buttons |
| Border/hover-cursor | `Border.controlSpec("hover-cursor", …)` | `alpha(color, 0.25)` | Row outline under cursor (owned by `CursorSurface`) |

### Rules

- Never write a hex literal, `"red"`, or a named color in plugin QML. If a new
  semantic role is genuinely needed, it must first exist in Omarchy's theme
  layer — this plugin extends nothing.
- `bar.urgent` means **error or destructive**, and nothing else. It is not used
  to mean "active": a live stream is signalled by the *selected fill* plus the
  check glyph, and on the bar by `BarIconButton.active`.
- Row state is carried by the row's own color (`statusColor` picks primary for
  streaming/connecting/busy, tertiary otherwise). No separate red/green status
  dot is introduced — this matches the Bluetooth panel's convention.
- Derived colors use `Qt.darker()` on the injected foreground only, so they
  follow a theme swap automatically. Never `Qt.rgba()` with fixed channels.

---

## 3. Typography

One family, resolved system-wide. `bar.fontFamily` binds to `Style.fontFamily`
(default `"monospace"`, which fontconfig maps to the user's Nerd Font via
`omarchy font set`). Icons are Nerd Font glyphs in that same family — there is
no icon font, no SVG set, and no emoji anywhere in this plugin.

### Scale

Every size is a `Style.font.*` token derived from `[font] base-size` (default
12px); the px column is the default resolution only.

| Token used here | Default px | Multiplier | Usage in this plugin |
|---|---|---|---|
| `Style.font.display` | 24 | 2.0 | Hero `󰠹` icon in `PanelHero` |
| `Style.font.title` | 14 | 1.167 | Row `󰠹` device icon |
| `Style.font.subtitle` | 13 | 1.083 | Row check glyph `󰄬` |
| `Style.font.body` | 12 | 1.0 | Device name, credential `TextField` text |
| `Style.font.bodySmall` | 11 | 0.917 | Empty-state / error copy, "Pairing…" plate label |
| `Style.font.caption` | 10 | 0.833 | Row status line, header note, `⋯` menu button labels + icons, rescan glyph |
| `Style.bar.iconFont` | 13 | — | Bar button glyph (owned by `BarIconButton`) |

Header treatment (`PanelSectionHeader`, text `"AIRPLAY"`) and hero meta
(`heroText`) are **uppercased at the content layer**, not by a font property:
`Model.js heroMeta()` returns `.toUpperCase()` strings and the header string is
authored uppercase. Weight is used at exactly one place — `font.bold: true` on
the header note.

### Rules

- Bind `font.family` to `bar.fontFamily` (or `Style.font.family`), never to
  `Style.resolvedFontFamily`; the alias path is what keeps `omarchy font set`
  working.
- No arbitrary `font.pixelSize`. If a size is not in the table, it does not
  ship.
- Glyphs are Nerd Font code points only: `󰠹` television (bar/hero/row), `󰄬`
  check (streaming), `󰇘` ellipsis (row menu), `󰓡` source, `󰕾`/`󰝟`
  unmute/mute, `󰅙` stop, `\uf021` refresh (rescan). No emoji as icon.

---

## 4. Spacing & Layout

### Base unit

All spacing goes through `Style.space(px)` or a named `Style.spacing.*` token,
both of which multiply by the theme's `effectiveSpacingScale` (spacing scale ×
font scale). The px values below are the pre-scale request.

| Token | Default | Usage in this plugin |
|---|---|---|
| `Style.spacing.xs` (3) | 3 | Gap between `⋯` menu buttons |
| `Style.spacing.sm` (4) | 4 | Horizontal padding of menu buttons |
| `Style.space(1)` | 1 | Device name ↔ status line gap |
| `Style.space(2)` | 2 | Rescan button vertical padding |
| `Style.space(4)` | 4 | Menu/credential slot top margin; bottom spacer |
| `Style.space(5)` | 5 | Rescan button horizontal padding |
| `Style.space(6)` | 6 | Row body left inset, empty-state x-offset, `ensureCursorVisible` margin, field↔submit gap |
| `Style.spacing.md` (6) | 6 | Extra row height when the menu or credential slot is open |
| `Style.space(8)` | 8 | Icon ↔ labels gap, labels ↔ right slot gap |
| `Style.spacing.rowGap` (8) | 8 | Height padding of the menu and credential slots |
| `Style.space(10)` | 10 | Header→list column spacing; menu/credential left inset |
| `Style.spacing.controlGap` (8) | 8 | Credential field horizontal padding |
| `Style.spacing.controlPaddingY` (6) | 6 | Credential field + menu button vertical padding |
| `Style.spacing.controlHeight` (28) | 28 | "Pairing…" busy plate height |
| `Style.space(12)` | 12 | Row body right inset; empty-state width inset |
| `Style.spacing.xl` (10) | 10 | Row body vertical breathing (added to content height) |
| `Style.space(14)` | 14 | Section root spacing; panel column spacing |
| `Style.space(22)` | 22 | Fixed width of the row icon slot and the row state slot |
| `Style.space(380)` / `Style.space(560)` | 380 / 560 | Popup content width / max height (in `Panel.qml`) |

### Layout

- **Spatial primitive:** a single vertical **stack**. Root `Section` is a
  `Column`; the header is a two-anchor `Item` (header left, note+rescan right);
  the device list is a `Repeater` of full-width rows.
- **Scroll owner:** the host panel's `ScrollView` in `Panel.qml` — *not* the
  section. `scrollArea.contentItem.interactive` is bound to
  `panelColumn.implicitHeight > scrollArea.height`, so the list only becomes
  interactive when it actually overflows, and `ensureCursorVisible(item)`
  drives `contentY` for keyboard navigation. The section never owns a
  Flickable, which is exactly what makes it embeddable in a cloned Display
  panel.
- **Width:** rows take `section.width`; the section takes `parent.width`. There
  is no max content width and no breakpoint system — the panel is a fixed-width
  popup (`fittedContentWidth(Style.space(380))`), and the shell, not this
  plugin, decides how that fits the screen.
- **Row anatomy:** fixed 22px icon slot, elastic label column, fixed 22px state
  slot. Elasticity lives only in the middle column, so a long device name
  elides (`Text.ElideRight`) instead of pushing the check glyph off-row.

### Rules

- No raw pixel numbers. `Style.space()` / `Style.spacing.*` only — that is what
  lets a theme make the whole shell denser without this plugin knowing.
- Asymmetric row insets (left 6, right 12) are intentional: the right side must
  clear the panel's scrollbar gutter, the left aligns the icon slot with the
  hero icon above it.

---

## 5. Components

Extracted from what exists. Omarchy `qs.Ui` primitives are consumed, not
re-implemented; only `DeviceRow` is defined by this plugin.

### DeviceRow (`airplay/Section.qml`, inline `component DeviceRow: CursorSurface`)

- **Structure:** `CursorSurface` root → `MouseArea` (row-height hit target,
  hosts `PanelToolTip`) + `Item rowBody` (icon `Text` | `Column` name/status |
  `Item rowState`) + `Item menuPanel` (collapsed) + `Item credentialPanel`
  (collapsed). Root `implicitHeight` sums the body plus whichever slots are
  open.
- **Variants:** idle · connecting · streaming · needs-credential · busy ·
  menu-open · credential-open. These compose; they are not exclusive modes.
- **Spacing:** Section 4 row tokens.
- **States:**
  - *default* — tertiary icon/status, transparent fill, no border.
  - *hover / keyboard-cursor* — identical paint by contract: `hasCursor` drives
    `CursorSurface` hover fill + hover-cursor border. Pointer entry does **not**
    paint directly; it writes `panel.cursorActive/focusSection/selectedIndex`
    and the paint follows, which is what guarantees exactly one highlight on
    screen. Reveals the `⋯` action button on a live row.
  - *active/current* — `current: row.streaming` → selected fill, primary-color
    icon and labels, `󰄬` in the state slot, row sorted to the top.
  - *focus* — no separate ring on the row; the row *is* the cursor target.
    Actual Qt focus exists only inside the credential slot, where `TextField`
    and `PanelActionButton` own the shared focus tokens.
  - *disabled* — `MouseArea.enabled: !isBusy`; the row stops accepting clicks
    while its own action is in flight.
  - *loading/busy* — status line becomes "Connecting…"/"Disconnecting…", the
    check and `⋯` are suppressed, and an open credential slot swaps the field
    for a bordered "Pairing…" plate.
  - *empty* — no row is rendered; the section's single `emptyText` line covers
    not-installed / not-running / scanning / none-found / error.
  - *error* — `errorText` renders in that same slot in `bar.urgent`. A rejected
    credential instead re-opens the prompt with an urgent placeholder ("Wrong
    code — try again") and a cleared field. Transport, protocol, request,
    discovery and stream failures have distinct sanitized copy. An error
    remains until a later complete status-plus-devices refresh succeeds.
- **Accessibility:** whole row is one click target with a `PanelToolTip`
  stating the outcome ("Stop mirroring" / "Mirror to <name>"). Keyboard: `j`/`k`
  move, Enter activates, Esc closes — routed from `PanelKeyCatcher` through the
  host panel's cursor. `PanelKeyCatcher.blocked` is bound to
  `credentialIp !== ""` so navigation keys become text while a PIN is being
  typed. Contrast follows the theme's foreground-on-background pair.
- **Motion:** inherits `CursorSurface`'s 60ms `ColorAnimation` on fill. Nothing
  else animates.
- **Layout:** stack row; owns no scroll.

### Consumed Omarchy primitives (contract only — do not restyle)

| Primitive | Role here |
|---|---|
| `Panel` / `KeyboardPanel` / `PanelKeyCatcher` | Popup shell, focus, key routing |
| `BarIconButton` | Bar entry; `active` tints it while mirroring |
| `PanelHero` | Title "Screen Mirroring", meta line, `󰠹` icon, trailing `ToggleSwitch` |
| `ToggleSwitch` | Stop-all affordance; `busy` while settling |
| `PanelSeparator` | Rule above the AIRPLAY block |
| `PanelSectionHeader` | "AIRPLAY" label |
| `Button` | Rescan (icon-only, spinning) and the three `⋯` menu actions (bordered) |
| `PanelActionButton` | Row `⋯` toggle; credential submit |
| `TextField` | PIN/password entry, `password: true` for passwords |
| `BorderSurface` | "Pairing…" busy plate |
| `PanelToolTip` | Row and control tooltips |
| `CursorSurface` | `DeviceRow` base |

---

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Where |
|---|---|---|---|
| State tint | 60ms | default (`ColorAnimation`) | `CursorSurface` / `PanelActionButton` fill on cursor/hover change |
| Indeterminate spin | continuous | linear | `Button.iconSpinning` on the rescan glyph, only while `discovering` |
| Toggle travel | owned by `ToggleSwitch` | — | Hero stop-all switch |
| Slot expand/collapse | none (instant) | — | `⋯` menu and credential slots change `implicitHeight` directly |

### Polling cadence (motion of *state*, not pixels)

| Condition | Interval |
|---|---|
| Panel open, action in flight or daemon starting | 1000ms |
| Panel open, idle | 3000ms |
| Panel closed, stream live | 10000ms |
| Panel closed, nothing live | not running |

### Controller state contract

- Each request owns a fresh socket transport and a five-second timeout.
- The XDG runtime socket is tried first; `/tmp/doubletake.sock` is attempted
  only after a pre-write connection failure, so a command is never duplicated.
- A poll stages `status`, then publishes it only together with the validated
  `devices` response. A failed second response leaves the previous rows intact.
- A complete automatic refresh is the only path that clears a prior controller
  error. Poll ticks coalesce while a request is busy, so failures cannot build a
  request backlog.

### Rules

- Only `transform`, `opacity`, and color animate. Row expansion is deliberately
  **not** animated: the height change is driven by content, and animating it
  would fight the panel's scroll position while the keyboard cursor is moving.
- Every animation maps to a real state change. The rescan glyph spins only
  while a scan is genuinely in flight; the toggle shows `busy` only while
  `settling`. There is no decorative motion, no hover that changes nothing.
- No `prefers-reduced-motion` hook exists at the Quickshell layer; the only
  continuous motion is the scan spinner, which is bounded by the request it
  represents. Recorded as debt in Section 8.

---

## 7. Depth & Surface

**Strategy: tonal-shift, with a 1px border used only for controls.**

The panel is flat. There is no shadow anywhere in this plugin, and no
gradient. Depth is expressed as alpha over the theme foreground:

| Level | Value | Usage |
|---|---|---|
| Recessed | `transparent` | Idle row |
| Raised | `hoverFillFor(…)` ≈ 4-8% alpha | Row under cursor/pointer |
| Selected | `selectedFillFor(…)` ≈ 18% alpha | Row currently mirroring |
| Control plate | `normalFillFor(…)` ≈ 4% alpha + `Border.controlSpec("normal")` 1px @ 40% alpha | "Pairing…" plate, bordered menu buttons |

Corner rounding is never hardcoded: every surface uses `Style.cornerRadius`,
which mirrors Hyprland's `decoration:rounding` and is `0` on a square theme.

---

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- **Keyboard reachability:** the primary connect/stop and pairing flow is
  reachable without a mouse — `j`/`k` (and arrows) move the cursor, Enter
  toggles the focused receiver, Enter in the credential field submits, Esc
  cancels the prompt or closes the panel, and Tab switches panels. The cursor
  is clamped to `rowCount` on every model change so it can never point past the
  list. Secondary Source and mute actions remain mouse-only as recorded below.
- **Single highlight invariant:** pointer and keyboard write to the same cursor
  state, so exactly one row is highlighted at any time. Rows must not paint from
  `containsMouse` (this is `CursorSurface`'s stated contract).
- **Visible state on every interactive element:** rows, both button kinds, the
  text field, and the toggle all have distinct rest/hover-cursor/active paint.
- **Text-input mode is explicit:** while a credential prompt is open,
  `PanelKeyCatcher.blocked` stops navigation keys from being swallowed as
  commands, so typing a PIN can never move the cursor.
- **Remote text is inert:** every plugin-owned `Text` uses `Text.PlainText`.
  Receiver-controlled strings are stripped of angle brackets before they enter
  shell-owned hero or tooltip components that do not expose `textFormat`.
- **Contrast:** inherited from the active Omarchy theme's foreground/background
  pair. This plugin never lowers contrast below `Qt.darker(fg, 1.5)` for
  meaningful text, and never uses color as the *only* signal — streaming is
  color **plus** the `󰄬` glyph **plus** list rank.
- **No emoji icons.** Nerd Font glyphs only (Section 3).

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| `⋯` row menu is mouse-only; `j`/`k` reveals it but no key opens it | `airplay/Section.qml` `menuButton` | Documented in README "Limitations"; stop has an Enter path, while mute and Source are secondary actions | Needs a key binding that does not collide with `j`/`k`/Enter; unassigned |
| No `prefers-reduced-motion` equivalent | rescan spinner | Quickshell exposes no such setting; the only continuous animation is bounded by an in-flight request | Revisit if Omarchy adds a shell-level motion preference |
| Credential values live in QML/JS strings and are cleared by dropping references, not by overwriting memory | controller/model credential path | JavaScript strings are immutable and GC-managed; physical zeroization is not achievable in this runtime. Mitigation is scope: the secret never reaches argv, a file, or a log — only the socket write buffer, which is dropped immediately after the write | Would require a native helper; out of scope |
| Screen-reader semantics are absent | whole panel | Quickshell/Qt Quick surfaces here expose no accessibility tree to AT on Wayland in this shell | Blocked on upstream Omarchy/Quickshell support |
| Layout is single-width; no responsive breakpoints | `Panel.qml` popup sizing | The surface is a fixed-width bar popup, not a page; height already adapts via `fittedContentHeight` + scroll | Not planned |

New debt is recorded here at the moment it is accepted — never silently.
