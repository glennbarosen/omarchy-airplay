# Screen Mirroring — AirPlay for the Omarchy bar

Mirror your desktop to an Apple TV (or any AirPlay 2 receiver) from the Omarchy
bar, the way macOS does it from Control Center: click the icon, pick the
receiver, done. Pairing happens inline — you never need a terminal.

- Discovers receivers on the LAN and lists them, active ones first
- Click to start mirroring, click again to stop
- Inline 4-digit PIN / password prompt for first-time pairing
- A `⋯` menu on a live stream: change what's shared, mute audio, stop
- The bar icon takes the active tint while mirroring
- Full keyboard navigation (`j`/`k`, Enter, Esc), like the first-party panels

## Requirements

This plugin is a **user interface**. The mirroring itself is done by
[doubletake](https://github.com/omarroth/doubletake), which you install
yourself — this plugin never installs anything, and never asks for sudo.

```bash
omarchy pkg aur add doubletake-git    # or doubletake / doubletake-bin
omarchy pkg add gst-plugin-va libva-utils   # Intel/AMD hardware encoding
```

`gst-plugin-va` is **not** in doubletake's package dependencies but is what
provides `vah264enc`. Without it GStreamer may fall back to software `x264enc`,
which is slow and hot on older CPUs. Check before you judge performance:

```bash
vainfo | grep -i h264        # want VAProfileH264* : VAEntrypointEncSlice
gst-inspect-1.0 vah264enc    # must resolve
```

NVIDIA users want `nvenc` instead; see **Settings** below.

Until doubletake is on your `PATH`, the panel shows an install hint instead of a
device list. Nothing breaks.

## Install

```bash
omarchy plugin add https://github.com/glennbarosen/omarchy-airplay.git
omarchy plugin enable baro.airplay
```

Plugins land **disabled** so you can read the code first. Please do — see
**Security** below for what to look at.

## First run

Click the icon, then click your receiver. The Apple TV shows a 4-digit code and
the row expands into an input; type the code and press Enter. Hyprland will also
ask for screen-capture permission — tick **remember this decision** so it stops
asking. Credentials persist to `~/.config/doubletake/credentials.json`.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `hwaccel` | `auto` | H.264 encoder passed to doubletake: `auto`, `vaapi`, `nvenc`, `openh264`, or `none` (software x264) |

```json
{ "id": "baro.airplay", "hwaccel": "vaapi" }
```

The value is whitelisted in QML before it ever reaches a command line.

## Changing what gets mirrored

doubletake has **no runtime command to change the capture source**. The
xdg-desktop-portal screencast session fixes it when the stream starts, and the
`restore_token` saved in `credentials.json` makes every later connect reuse that
same source — which is what makes reconnecting prompt-free.

So **⋯ → Source** runs `airplay/reshare.sh`, which disconnects, removes *only*
the `restore_token` key for that receiver, restarts the daemon (it caches
credentials for the life of the process), and reconnects — landing you back in
the portal's source picker. Pick a different monitor, window or region there,
and don't tick "remember" if you expect to switch again soon.

The daemon's only other live controls are `mute` / `unmute`. Everything else —
fps, bitrate, `-no-cursor` — is fixed when the daemon starts.

## Embedding in another panel

`airplay/Section.qml` is host-agnostic: it reads only the cursor surface every
first-party Omarchy panel already exposes (`opened`, `cursorActive`,
`focusSection`, `selectedIndex`, `reflowingText`, `ensureCursorVisible(item)`).

So if you'd rather have mirroring inside the **Display** panel than in its own
bar icon — the way macOS puts Screen Mirroring under Control Center → Display —
clone that panel and drop the section in:

```bash
omarchy plugin clone omarchy.monitor    # becomes <you>.monitor
```

In the clone's `Panel.qml`:

```qml
import "../baro.airplay/airplay"        // this plugin, installed alongside

Section {
    id: airplaySection
    width: parent.width
    panel: root
    bar: root.bar
}
```

then add an `"airplay"` branch to that panel's `visibleSections`, `sectionCount`
and `activateCursor`. Leave `baro.airplay` installed but **not** added to the bar
so you don't get two mirroring UIs. Cloning a first-party panel means you own it
and merge upstream changes yourself, so keep the diff small and marked.

## Security

Plugins run **unsandboxed inside your long-lived `omarchy-shell` process**. Read
the code. It is four short files; here is what to look for:

- **No network access of its own.** This plugin opens no sockets, fetches
  nothing, and has no telemetry. All network activity belongs to doubletake.
- **No install hooks, no sudo, no `curl | bash`.** Installing the backend is a
  command you run yourself, documented above.
- **Subprocesses it runs:** `doubletake-ctl` (status, devices, discover,
  connect, disconnect, mute, unmute), `doubletake -daemonize` to start the
  daemon on demand, one `sh -c 'command -v …'` probe, and `airplay/reshare.sh`.
  Nothing else.
- **`airplay/reshare.sh` writes to doubletake's credentials file.** This is the
  one thing worth scrutinising, and the file explains itself at the top. It
  removes only the `restore_token` key for a named receiver; the Ed25519 pairing
  material is untouched. The device id and target are regex-validated, the
  target file is refused if it is a symlink or not a regular file, the write is
  atomic (temp file + `mv`, mode 600), and the result is rejected unless it is a
  non-empty JSON object.
- **Pairing codes are passed as an argv to `doubletake-ctl`**, so they are
  briefly visible in `ps`. That is doubletake's CLI interface — it offers no
  stdin path. For a one-time 4-digit code this is a small exposure; if your
  receiver uses a fixed password, know that it applies there too.
- **The daemon is started on demand**, only when you open the panel or connect.
  Nothing runs at login unless you enable doubletake's systemd user unit
  yourself.

## Limitations

- Latency is roughly 150–400 ms end to end over Wi-Fi. Fine for slides, video
  and demos; not for typing in a terminal or watching your own cursor.
- doubletake is young and, by its author's own statement, largely LLM-written. A
  tvOS update can break it; this plugin can't help with that.
- The `⋯` menu is mouse-only. `j`/`k` reveals it but no key opens it yet.
- Tested against an Apple TV 4K (3rd gen, `AppleTV14,1`) on tvOS 26.6. Other
  receivers depend entirely on doubletake's support.

## License

MIT — see [LICENSE](LICENSE).
