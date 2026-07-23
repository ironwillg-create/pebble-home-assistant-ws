# Changelog

All notable changes to this fork are documented here. Format: Keep a Changelog.

## [Unreleased] - fork setup 2026-07-23

### Added
- Forked from skylord123/pebble-home-assistant-ws for Will's Pebble Time 2 (emery).
- Verified build on the ICC pebble-dev toolchain: Proxmox LXC 118 "pebble-dev"
  (Ubuntu 24.04, pebble-tool 5.0.39, SDK 4.17, headless Xvfb emulator).
- Confirmed clean build for all target platforms (aplite/basalt/chalk/diorite/emery)
  and verified the emery first-run "Setup required" screen renders in the emulator.

### Notes
- HA connection (URL + Long-Lived Access Token) is entered at runtime via the Clay
  config page in the Pebble phone app; it is not baked into the build.
- Favorites / pinned entities are chosen on-watch after the app connects to HA.
- HA target for Will: http://192.168.4.74:8123 (LAN). Voice control requires the HA
  Conversation integration. Remote (away-from-home) control needs HA exposed via a
  Cloudflare tunnel (deferred optional phase).