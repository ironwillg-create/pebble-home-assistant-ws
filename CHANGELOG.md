# Changelog

All notable changes to this fork of
[skylord123/pebble-home-assistant-ws](https://github.com/skylord123/pebble-home-assistant-ws)
are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Upstream releases are not repeated here; this file starts where the fork diverges
(upstream 2.0).

## [2.2.0] - 2026-08-10

### Added

- **Spoken replies.** Assistant answers are now read aloud through the watch
  speaker (`src/simply/simply_audio.c`, `src/js/ui/audio.js`,
  `src/js/app/SpeechService.js`). Off unless a speech token is configured.
  - The C runtime gained a speaker subsystem: 4-bit IMA ADPCM decoded on the
    watch and streamed into `speaker_stream_write()` through a ring buffer,
    with credit-based flow control so the phone can never wrap the ring onto
    audio that has not been played yet. Ported from the Craft Agents watchapp,
    where the chain is hardware-proven.
  - Two watchdogs, because the two failure modes look different: a speaker that
    accepts nothing while reporting Idle has wedged, while one that claims to
    be playing but never drains can only be caught by bounding playback against
    the clip's known duration.
  - The ring is `min(clip, 64 KB)` and steps down to 32 or 16 KB if the heap
    cannot spare it, rather than refusing to speak.
  - Speech comes from the voice-dispatch `/api/v2/watch/speak` endpoint, NOT
    from Home Assistant's own TTS. HA's assist pipeline returns an mp3 URL and
    neither pkjs nor the watch can decode mp3 or resample it; the voice-dispatch
    endpoint already returns ADPCM at the exact rate the speaker wants,
    loudness-processed for this speaker and cached by content. The pipeline
    therefore stays at `end_stage: "intent"` and the reply TEXT is what gets
    spoken.
  - The bearer token is a setting (`speech_token`), never a compiled-in
    constant, so it stays out of the source tree and out of git.

### Notes

- The emery emulator has no audio device. It exercises the whole chain but
  cannot tell you whether the result is audible; that needs hardware.

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
