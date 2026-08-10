# Changelog

All notable changes to this fork of
[skylord123/pebble-home-assistant-ws](https://github.com/skylord123/pebble-home-assistant-ws)
are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Upstream releases are not repeated here; this file starts where the fork diverges
(upstream 2.0).

## [2.1.0] - 2026-08-10

### Added

- **Touch support in the Pebble.js runtime** (`src/simply/simply_touch.c`,
  `src/js/ui/touch.js`). The runtime now subscribes to the SDK's TouchService
  and forwards touchdown/liftoff to the JS side, which derives `tap` and `swipe`
  events on the visible window. This is generic Pebble.js infrastructure, not
  dashboard-specific: any window can now register `tap`, `swipe` or raw `touch`
  handlers.
  - The digitizer is powered only while a visible window has a touch handler
    registered, auto-managed the same way `accelData` already auto-subscribes
    the accelerometer.
  - Continuous position updates are opt-in (`wantsMoves`) and off by default;
    they fire fast enough to saturate AppMessage and neither taps nor swipes
    need them.
  - Compiled out entirely on platforms with no digitizer (aplite, basalt, chalk,
    diorite), the same way `simply_voice` handles aplite's missing microphone.
- **`Window.prototype.elementAt(pos, filter)`** - hit-tests a point against the
  window's elements in reverse draw order, which is how a tap coordinate becomes
  the element under the finger.
- **Dashboard page** (`src/js/app/pages/DashboardPage.js`) - tile grid screens
  whose layout is defined in Home Assistant rather than compiled into the app,
  so screens can be rearranged without a rebuild and sideload. Reads a `screens`
  attribute off `sensor.pebble_dashboard` (overridable via the
  `dashboard_entity` setting).
  - Tiles with an `entity` render live state and colour from it; tiles without
    one are pure shortcuts (scripts, scenes, any `domain.service`).
  - `confirm: true` arms a tile on first press and only fires on the second,
    within 4 seconds.
  - Reachable by tap, or by button: up/down move the selection and roll over
    into the neighbouring screen at either end, so every tile on every screen is
    reachable without touch. Long-press select refreshes state.
  - Hidden from the main menu entirely when no dashboard entity exists.

### Notes

- Touch and speaker APIs exist only on emery, flint and gabbro in SDK 4.17.
- The Pebble emulator has **no `emu-touch`**; touch gestures cannot be injected
  and can only be verified on hardware. This is why button access to every
  screen is a requirement rather than a nicety.
