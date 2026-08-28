# Screen Mirroring — AirPlay for the Omarchy bar

Mirror your desktop to an Apple TV (or any AirPlay 2 receiver) from the Omarchy
bar, the way macOS does it from Control Center: click the icon, pick the
receiver, done. Pairing happens inline — you never need a terminal.

- Discovers receivers on the LAN and lists them, active ones first
- Click to start mirroring, click again to stop
- Inline 4-digit PIN / password prompt for first-time pairing
- A `⋯` menu on a live stream: change what's shared, mute audio, stop
- The bar icon takes the active tint while mirroring
- Keyboard navigation for receiver connect/stop and pairing (`j`/`k`, Enter,
  Esc), like the first-party panels

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

NVIDIA users want `nvenc` instead; see **Settings** below. This release also
requires a doubletake build whose daemon supports the `reset-restore-token`
control command.

Until doubletake is on your `PATH`, the panel shows an install hint instead of a
device list. Nothing breaks.

## Install

```bash
omarchy plugin add https://github.com/glennbarosen/omarchy-airplay.git
omarchy plugin enable baro.airplay
```

Plugins land **disabled** so you can read the code first. Please do — see
**Security** below for what to look at.

## Removing it

```bash
omarchy plugin disable baro.airplay
omarchy plugin remove baro.airplay
```

That takes the widget out of your bar and deletes the plugin directory. It leaves
doubletake and its saved pairings alone, since this plugin did not install them.
To go further:

```bash
omarchy pkg drop doubletake-git      # or doubletake / doubletake-bin
rm -rf ~/.config/doubletake          # saved receiver pairings
```

If you embedded `airplay/Section.qml` in a cloned Display panel, remove that import
and the `Section { … }` block from the clone first, or the panel will fail to load.

## First run

Click the icon, then click your receiver. The Apple TV shows a 4-digit code and
the row expands into an input; type the code and press Enter. Hyprland will also
ask for screen-capture permission — tick **remember this decision** so it stops
asking. Credentials persist to `~/.config/doubletake/credentials.json`.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `hwaccel` | `auto` | H.264 encoder passed to doubletake: `auto`, `vaapi`, `nvenc`, `openh264`, or `none` (software x264) |
| `portRange` | `60000-60010` | Consecutive UDP ports doubletake may bind for receiver timing/audio; values must be within 1-65535 and contain at least 3 ports |

```json
{ "id": "baro.airplay", "hwaccel": "vaapi", "portRange": "60000-60010" }
```

Both values are strictly parsed/whitelisted in QML before they reach the lazy
daemon start. Invalid values fall back to their defaults; free-form setting text
is never forwarded to argv.

### Firewall

The plugin **never edits your firewall** and never asks for elevated privileges.
If UFW is active with default-deny incoming, allow the configured UDP range from
your private LAN yourself. For example, replace the subnet with your actual
private network:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 60000:60010 proto udp comment 'doubletake AirPlay'
sudo ufw status numbered
```

Keep the UFW range in sync with `portRange`. Do not expose these ports to the
public internet.

## Changing what gets mirrored

doubletake cannot switch an active portal capture in place. The
xdg-desktop-portal screencast session fixes the source when the stream starts,
and the `restore_token` saved in `credentials.json` makes every later connect
reuse that same source — which is what makes reconnecting prompt-free.

So **⋯ → Source** sends
`{"cmd":"reset-restore-token","target":"<receiver IP>"}` directly to the
daemon. doubletake owns the disconnect, targeted token reset and reconnect,
landing you back in the portal's source picker. The plugin never reads or
rewrites the credentials file and never signals/restarts the daemon for this
action. Pick a different monitor, window or region there, and don't tick
"remember" if you expect to switch again soon.

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
the code. The control path is intentionally small; here is what to look for:

- **No network access of its own.** The plugin opens only doubletake's local
  Unix control socket, fetches nothing, and has no telemetry. AirPlay network
  activity belongs to doubletake.
- **No install hooks, no sudo, no firewall mutation, no `curl | bash`.**
  Installing the backend and configuring UFW are commands you run yourself,
  documented above.
- **Control uses no subprocesses.** Status, discovery, connect/disconnect,
  credentials, mute/unmute and Source all use one-request/one-response JSON on
  `$XDG_RUNTIME_DIR/doubletake.sock` (falling back to `/tmp/doubletake.sock`).
- **The plugin never reads or writes doubletake's credentials file.** Source
  reset is a targeted daemon request; credential ownership stays with
  doubletake.
- **Pairing values never reach argv, a file or a log.** They exist in QML/JS
  strings and one socket write buffer until references are dropped on write or
  a terminal path. JavaScript strings are immutable and garbage-collected, so
  this is scoped cleanup, not a claim of physical memory zeroization.
- **Subprocess boundary:** one constant `command -v doubletake` availability
  probe and `doubletake -daemonize` on first use, with only whitelisted
  `hwaccel` and validated `portRange` settings. Nothing else.
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

## Attribution

The direct Unix-socket controller's one-request lifecycle, bounded cleanup and
generation-guard approach reuse substantial implementation concepts from
Mathias Ringhof's
[omarchy-airplay](https://github.com/mathiasringhof/omarchy-airplay); thank you.
The wire protocol and targeted restore-token semantics come from Omar Roth's
[doubletake](https://github.com/omarroth/doubletake), licensed
LGPL-3.0-or-later.

## License

MIT — see [LICENSE](LICENSE).
