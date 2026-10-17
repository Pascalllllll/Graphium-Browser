# Changelog

Every release of Graphium, newest first. Download the files from the
[Releases page](https://github.com/Pascalllllll/Graphium-Browser/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and version numbers follow [Semantic Versioning](https://semver.org): the
first number changes when something you rely on stops working the old way,
the second when features are added, the third for fixes.

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-10-17

The first public release.

### Downloads

| Computer | File |
| --- | --- |
| Windows (installer, Intel/AMD and ARM) | `Graphium-1.0.0-win-setup.exe` |
| Windows (no install) | `Graphium-1.0.0-win-x64-portable.exe` |
| Mac with Apple chip (M1 and newer) | `Graphium-1.0.0-mac-arm64.dmg` |
| Mac with Intel chip | `Graphium-1.0.0-mac-x64.dmg` |
| Linux, any distribution | `Graphium-1.0.0-linux-x86_64.AppImage` |
| Debian, Ubuntu, Mint | `Graphium-1.0.0-linux-amd64.deb` |
| Linux, unpack and run | `Graphium-1.0.0-linux-x64.tar.gz` |

Linux ARM builds have `arm64` in place of `x86_64`, `amd64` or `x64`. The apps aren't
signed with a paid certificate, so Windows and macOS warn on first launch; the
[README](README.md#download) shows how to open them. `SHA256SUMS.txt` lists
the checksum of every file.

### Added

- Browsing on Chromium through Electron 44, so sites, YouTube, Gmail and
  Google sign-in behave as they do in Chrome.
- Ad and tracker blocking from the first page, using Ghostery's blocker and
  its public lists, with a per-site switch on the shield button in the toolbar.
- Tabs, windows and private windows. Private windows keep their own cookies
  and permissions and forget them when closed.
- Address bar completion from history, a bookmark star, and a new tab page
  with shortcuts you can add and remove.
- History (`Ctrl+H`), downloads (`Ctrl+J`), find in page, zoom, full screen,
  and reopening closed tabs (`Ctrl+Shift+T`).
- Command palette (`Ctrl+K`): one fuzzy search over open tabs, recently closed
  tabs, bookmarks, history and about 30 actions, with memory use per tab and a
  calculator.
- Split view (`Ctrl+Shift+S`): two tabs side by side. The address bar follows
  the pane you click.
- Light and dark themes with a custom accent color.
- A clear error page for failed loads, and a "Continue anyway" choice on
  certificate errors.

### Memory

- Background tabs sleep after 10 minutes and wake where you left them. Tabs
  playing sound, and tabs in a split, stay awake.
- When the computer runs low on memory, every background tab sleeps at once.
- Tabs on the same site share one process.
- With 7 busy tabs open on Linux, memory went from about 1,870 MB to about
  980 MB once the background tabs were asleep.

### Privacy and security

- No accounts, analytics or telemetry. History, settings and permissions stay
  on your computer. See [PRIVACY.md](PRIVACY.md).
- Cookies are encrypted on disk. The app only runs code from its own archive,
  checks that archive for tampering at startup, and can't be started as a
  plain Node.js process.

### Known limitations

- No automatic updates yet. New versions are posted on the Releases page.
- No Chrome extensions, sync or password manager.
- The download is about 100 MB because it carries the whole Chromium engine.

[Unreleased]: https://github.com/Pascalllllll/Graphium-Browser/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Pascalllllll/Graphium-Browser/releases/tag/v1.0.0
