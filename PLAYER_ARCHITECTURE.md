# Expanded player

The expanded player is a client-side presentation of the existing player.
It adds no server API, additional audio element, or stream. The optional CD scene
uses a pinned, locally served Three.js dependency, loaded only on demand.
The server only serves the new static scripts and stylesheet.

Stage 1 files:

- New modules: `web/player-bridge.js`, `web/player-views.js`, `web/expanded-player.js`.
- New styles: `web/expanded-player.css`.
- Integration: `web/index.html`, `web/player.js`, `web/settings.js`, `web/visualizer.js`, `http_api.py`.
- Translations: `web/locales/en.json`, `web/locales/ru.json`.
- Checks: `tests/client.test.cjs`, `tests/test_server.py`.
- Documentation: `PLAYER_ARCHITECTURE.md`, `SESSION_NOTES.md`.

Stage 2 files:

- New view: `web/album-view.js`; new unit checks: `tests/album-view.test.cjs`, `tests/bootstrap.test.cjs`.
- Registration and styling: `web/player-views.js`, `web/bootstrap.js`, `web/index.html`, `web/expanded-player.css`, `http_api.py`.
- Translations: `web/locales/en.json`, `web/locales/ru.json`.
- Integration checks: `tests/client.test.cjs`, `tests/test_server.py`.
- Documentation: `PLAYER_ARCHITECTURE.md`, `SESSION_NOTES.md`.

Stage 3 files:

- New preferences service: `web/player-appearance.js`; checks: `tests/player-appearance.test.cjs`.
- Controls and presentation: `web/settings.js`, `web/expanded-player.js`, `web/album-view.js`, `web/expanded-player.css`, `web/index.html`.
- Assets and translations: `http_api.py`, `web/locales/en.json`, `web/locales/ru.json`.
- Regression checks: `tests/client.test.cjs`, `tests/album-view.test.cjs`, `tests/test_server.py`.
- Documentation: `PLAYER_ARCHITECTURE.md`, `SESSION_NOTES.md`.

Stage 4 files:

- New modules: `web/audio-analysis.js`, `web/effects-view.js`.
- Shared audio integration: `web/audio-wave.js`, `web/visualizer.js`, `web/player-bridge.js`.
- View integration: `web/player-views.js`, `web/expanded-player.js`, `web/settings.js`, `web/index.html`, `web/expanded-player.css`, `http_api.py`.
- Translations: `web/locales/en.json`, `web/locales/ru.json`.
- New checks and fixtures: `tests/audio-analysis.test.cjs`, `tests/effects-view.test.cjs`, `tests/audio-fixture.cjs`.
- Updated checks: `tests/client.test.cjs`, `tests/bootstrap.test.cjs`, `tests/test_server.py`.
- Documentation: `PLAYER_ARCHITECTURE.md`, `SESSION_NOTES.md`.

Stage 5 files:

- New presentation controller and renderer: `web/cd-view.js`, `web/cd-scene.mjs`.
- Pinned graphics library: `web/vendor/three-r180/three.module.min.js`, `three.core.min.js`, `LICENSE`, `package.json`, `manifest.json`.
- Registration and shell: `web/player-views.js`, `web/expanded-player.js`, `web/index.html`, `web/expanded-player.css`.
- Static asset routes and translations: `http_api.py`, `web/locales/en.json`, `web/locales/ru.json`.
- New tests and fixture: `tests/cd-view.test.cjs`, `tests/cd-scene.test.cjs`, `tests/cd-fixture.cjs`.
- Integration checks: `tests/client.test.cjs`, `tests/bootstrap.test.cjs`, `tests/test_server.py`.
- Documentation: `THIRD_PARTY_NOTICES.md`, `PLAYER_ARCHITECTURE.md`, `SESSION_NOTES.md`.

## Integration

- `player.js` remains responsible for playback, queue actions, and listening.
- `player-bridge.js` is the boundary between application state and presentation.
  `getState()` returns an immutable snapshot of track metadata, artwork URL,
  playback state, position, duration, volume, repeat/shuffle, and queue size.
  `subscribe(listener)` immediately publishes a snapshot and returns an unsubscribe
  function. Updates come from audio events and explicit state changes; there is
  no polling or frame loop. Shared commands delegate to existing playback actions.
- `expanded-player.js` owns the modal shell, tab keyboard navigation, selected
  mode, focus restoration, animation, and view lifecycle.
- `player-views.js` registers factories for the three mode IDs: `album`, `effects`,
  and `cd`. All have failure fallbacks when their optional modules are unavailable.
- `album-view.js` registers the real album view after the registry is loaded.
  It receives the same read-only snapshots as the placeholders. The script is
  optional in the bootstrap manifest: a load failure leaves a translated fallback
  registered and does not prevent the main application from starting.
- `effects-view.js` registers a canvas view and receives a limited analysis
  facade through its factory context. It never receives the audio element.

The compact controls are the same DOM nodes in both layouts. They move from
`compactPlayerHome` to `expandedPlayerControls` while the native modal dialog is
open, and move back on collapse. Their event handlers and IDs are retained.
The `audio` element stays outside both containers and is never moved or replaced.
Native modal behavior keeps library controls out of keyboard navigation;
additional dialogs, such as the queue, can still open above the expanded player.

## View contract

Register a factory using `playerViews.register(id, factory)`. A factory receives
an optional context with an `analysis` facade and an `artworkFactory` callback
(for creating the shared album fallback), and returns:

```javascript
{
  mount(container) {},
  update(snapshot) {},
  setActive(active) {},
  setAppearance(appearance) {}, // Optional: effective motion and visual preferences.
  dispose() {}
}
```

Views receive read-only snapshots. They must not access `audio`, `queueModel`,
application globals, or the HTTP API. They may use shared translation and text
escaping helpers. Playback controls remain in the shell; presentation controls
belong to each view.

Analysis consumers use `context.analysis.createConsumer()`. Each lease exposes
`setActive`, `unlock`, `read`, `subscribe`, `status`, and `dispose`; it does not
expose the AudioContext, source, analyser node, or HTMLAudioElement. View-local
visualization controls may store browser-local presentation preferences.
`read(frequencies, samples)` currently fills 128 frequency bins and 256 time-domain
samples; it returns false without reading when the lease is inactive or unavailable.

Factories run only when their view is opened. Switching modes disposes the
previous view. Collapse pauses it immediately and disposes it after the closing
transition. Updates are unsubscribed while closed. View errors are isolated and
show a translated fallback while playback and controls continue working.

## Preferences and accessibility

`expandedPlayerMode` is stored in localStorage; an unknown mode falls back to
`album`. The expanded state itself is not restored after a page reload.
Tabs support Left/Right, Home/End, and normal button activation. Escape collapses
the player; focus returns to the expand button. Clicking the scene does not
dismiss it. Reduced motion disables the opening/closing transition.
The layout inherits the existing Forest, Midnight, and Sand theme tokens.

The existing library wave is suspended via `expanded-player-change` while the
expanded player covers it, then resumes under its normal visibility rules.

## Appearance preferences

`player-appearance.js` owns the browser-local `expandedPlayerAppearance` value:

```json
{"background":"ambient","intensity":40,"animation":true}
```

Background choices are `none`, `ambient`, `waves`, and `texture`. Intensity is a
validated integer from 0 to 100. Background opacity is limited to 0.3; the
default intensity keeps the previous album glow opacity of 0.12. Zero intensity
or `none` hides background layers. Disabling the background retains the previous
intensity for later use. Theme colors, text/icon sizes, library wave mode, and
the last expanded-player mode remain separate preferences.

Matching controls exist in the main Settings form and the expanded player's
Appearance panel. Changes apply immediately and synchronize both panels without
submitting the settings form or calling the server. The panel supports normal
keyboard controls; opening it focuses its first setting.

The service publishes read-only preferences including `reducedMotion` and
`motionEnabled`. The manual animation preference is retained even when the
system requests reduced motion. Effective motion requires both user permission
and no system reduction. Changing the system preference updates the UI and scene
immediately. Turning motion off removes cover crossfades and shell transitions,
clears outstanding fade cleanup, and makes collapse immediate.

Ambient glow uses the loaded album cover in album mode and theme gradients for
other modes. Waves and texture are CSS decorations and do not read audio. Only
the waves background has a continuous animation: it is enabled solely during
active, non-buffering playback, with the expanded player visible, a nonzero
intensity, and effective motion enabled. Pause, buffering, a hidden document,
collapse, or motion restrictions remove that animation. There is no new JS frame
loop, timer, audio graph, or network API. Text and controls retain solid theme
surfaces so background intensity does not alter their contrast.

## Album artwork

The album view requests only the existing `/covers/<hash>.jpg` URL supplied in
the snapshot. Images are created when the album view is active. Repeated
position updates, or another track using the same image, do not reload it.
Title, artist, and album stay in the common shell; image alternative text follows
the current album and interface language.

Images retain their proportions using `object-fit: contain`. Cover changes use
a 300 ms opacity transition, disabled for reduced motion. At most two foreground
image layers are retained. A one-shot cleanup timeout handles interrupted CSS
transitions; there is no frame loop. A static blurred copy of the same cached
cover supplies a low-opacity background inside the scene only. Status text has
a solid theme surface behind it; controls and track metadata remain outside.

Missing artwork, failed image loads, and zero-sized images have separate
translated fallback messages. Request generation checks discard late responses
from previous tracks. Hiding or disposing a view removes pending image handlers,
releases image sources, and cancels transition cleanup. A failed URL is not
retried on every position update; reopening the view allows a fresh attempt.

## Next stages

The CD MVP is implemented. Visual acceptance and refinement of the materials,
touch interaction, and performance on real devices remain before calling it
fully accepted. Later interface reorganization is recorded separately in session
notes; its layout requirements have not yet been specified.

Visual desktop/mobile acceptance remains necessary. Automated tests cover the
state-preservation, command, lifecycle, localization, and keyboard behavior;
their DOM model does not validate browser layout, touch behavior, or focus trapping.

## Interactive CD case

`cd-view.js` owns presentation controls, input, motion, and lifecycle. It receives
only the snapshot and an album-view factory. `cd-scene.mjs` owns GPU resources and
imports the pinned Three.js 0.180.0 modules (about 720 KB combined). These MIT
licensed files are self-hosted, with upstream provenance and SHA-256 hashes in
the vendor manifest. No CDN, package installation, or build step is required.
Only the lightweight controller is part of normal bootstrap; the renderer and
library are imported when the visible CD tab first requests supported 3D.

The scene contains a transparent jewel case, hinged lid with album insert,
printed disc with a center hole, and a separate fixed holder. The existing cover
URL supplies the insert and disc texture; missing artwork uses a generated
accent-colored texture. Theme colors update in place. Lid controls, pointer/touch
dragging, arrow keys, and a reset button affect presentation only. Decorative
disc rotation eases down on pause and does not follow or alter the audio clock.
Reduced motion or disabled player animation stops spin and applies lid changes
immediately. Clicking the scene does not collapse the player.

The browser-local `expandedPlayerCD` preference stores `quality` as `auto`, `3d`,
or `static`. Auto uses static album artwork when reported device memory is at
most 2 GB or CPU concurrency is at most 2, WebGL2 is unavailable, or eight
consecutive measured render submissions exceed 80 ms after three warmup frames.
These are conservative heuristics; CPU submission timing does not measure GPU
completion. The user can explicitly try 3D or select static artwork.

Rendering is on demand, at most 30 fps. Pixel ratio is capped at 1.25, the logical
backing size fits within 1000 by 540 pixels preserving aspect, transmission uses
half resolution, and shadows use a 512-pixel map. Pause stops the loop after
deceleration and lid settling; hidden pages, collapsed players, and inactive
views stop it immediately. The camera fits the current case and lid bounds in
portrait and landscape. The scene adds no audio graph or analysis consumer.

Context loss and renderer/import failures show the shared static album view,
with an explicit retry. Generation checks ignore stale imports and image loads.
Disposal releases timers, event handlers, pending images, textures, geometries,
materials, environment maps, and the WebGL context. The server serves only an
explicit list of vendor assets; other vendor paths and traversal return 404.

Tests exercise lifecycle and fallback with a mock renderer, plus actual Three.js
geometry, camera projection, cover texture ownership, resource disposal, and
vendor integrity without a GPU. Integration tests verify unchanged audio source,
position, queue, listening session, and no added audio context or view requests.
These checks do not compile real shaders or establish visual quality, mobile
gesture behavior, or acceptable frame time on target hardware.

## Shared audio analysis and effects

`audio-analysis.js` owns one lazily created AudioContext, one media-element source,
and one AnalyserNode. The existing library wave now uses this owner instead of
creating its own graph. The audible path connects directly to the destination;
the analyser is a separate branch connected only when consumers need samples and
playback is ready. Pausing, buffering, hiding, or disposing a consumer does not
disconnect the destination, close/suspend the context, or replace the audio element.
Once an element has been routed, its context is retained for that page's lifetime.

Context resume happens before initial routing. If all consumers disappear during
resume, the element is left on its original native path. A browser gesture refusal
allows an explicit retry. Future gestures can also resume an already attached
context with all renderers off, since its destination is still the audible path.
An analysis failure disconnects only the analysis branch. A canvas failure releases
only that view's lease. The service owns no animation loop.

`effects-view.js` supplies a logarithmic 40-bar spectrum and a time-domain waveform.
They use the same frequency/time-domain samples and a single bounded 30 fps canvas
loop per active view. The canvas uses fixed 960×360 backing pixels, without an
unbounded device-pixel-ratio multiplier. Pausing, buffering, seeking, hiding the
page, switching views, zero effect intensity, or motion restrictions stop rendering
and analysis reads. The analyser may stay allocated, but is disconnected when no
consumer needs it. Library wave rendering is suppressed while the expanded player
covers it, so switching between the two does not create a second audio source.

The browser-local `expandedPlayerEffects` value contains:

```json
{"preset":"spectrum","intensity":60,"enabled":true}
```

These controls are independent of background intensity and the library wave mode.
Global player animation preferences and system reduced motion still have priority.
Labels and canvas colors update with interface language and theme. Unsupported
canvas/Web Audio or renderer failure shows a localized fallback with normal controls
still available. If the optional effects script cannot load, the main player starts
with the registered fallback. No server API, second stream, or dependency is added.

Automated graph tests assert that repeated view changes retain exactly one context,
source, and analyser and never disconnect the destination. Browser and physical
audio acceptance is still required; mocked graph tests do not establish audible
continuity on a particular browser or device.
