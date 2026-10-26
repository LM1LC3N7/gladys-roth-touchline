# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTP goes through our own client on `node:http`). It
reads the room thermostats of a Roth Touchline underfloor heating through its
Ethernet controller (two CGI scripts on the local network, no account) and
shows one Gladys device per room; setpoints, modes and week programs can be
changed behind two off-by-default options, bounded. Not Touchline SL (cloud,
another integration). Never tested with a real controller, not affiliated
with Roth.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit (`gi ci` runs all of them plus the Docker build and the store validator).

## Architecture

```
index.js                     SDK bootstrap only
src/handlers.js              every SDK handler -> the app (shared with the tests)
src/app.js                   TouchlineApp: pacing (monotonic clock), rounds, failures, pause,
                             devices, states, badges, status, the test button, the commands
src/touchline/client.js      the controller: count, device, write (echo), one request at a time
src/touchline/http.js        node:http transport: deadline, size cap, `sent`, beforeSend
src/touchline/xml.js         the XML request and answers, read linearly, bounded
src/touchline/model.js       answers -> checked values (pytouchline_extended shapes)
src/devices.js               -> the Gladys devices and their states (pure), kept features
src/store.js                 /data/roth-touchline-state.json: last attempt, pause, last write
src/publisher.js             states within 300/min
src/config.js                config_schema normalized (host, allow_setpoints, allow_modes,
                             max_setpoint, poll_interval, language)
src/constants.js             the CGI, feature roles, modes, programs, limits, timings
src/i18n.js                  runtime texts, names, refusals (en/fr)
test/helpers/fakeController.js  the fake controller behind the transport; Gladys is the SDK's fake
test/helpers/fakeTimers.js   virtual clock; test/helpers/app.js the app wired for the tests
test/realclock.test.js       the app on the real clock (sped up), a real local HTTP server
scripts/cover.mjs            cover.png generator
```

## Rules

- **External ids are forever.** `ext:<selector>:touchline:<ownerKurzID>-<kurzID>`
  and the feature roles of `src/constants.js` `FEATURES` (and the select
  option values) are published: never rename them. The position `G<i>` is
  never part of an id.
- **Safety of the commands.** Both options off by default; a command is
  decided on a fresh read of the device (never on memory), its ids checked,
  within the limits of the device and the ceiling, re-checked in
  `beforeSend`; sent by 3.5 s or refused unsent; a write that may have left
  is "sent, without confirmation", never "not sent". No switch, no writable
  binary. The limits of the device (`SollTempMinVal`/`SollTempMaxVal`) and
  `CD.upass` are never written nor asked.
- **Pace.** Never two reads within the interval, whatever asks; the clock is
  read once per decision (`dueAt(mono)` takes the instant); durations on the
  monotonic clock, `/data` on the wall clock; every test of the app uses a
  clock that moves at each read, and `test/realclock.test.js` proves the reads
  start on a real clock.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  the address of the controller (there is no secret, but the address stays
  out of logs and `/data`).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the one-time 0.1.0 is in TODO.md). `test/manifest.test.js` checks
  they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  `test/manifest.test.js` ties the manifest to the code (defaults, action
  handler, no `keywords`/`countries` before `gladys_version >= 5.3.0`).
- **User-facing text** is bilingual (English and French): refusals, status
  messages, manifest texts, `docs/en.md` / `docs/fr.md`, kept in sync; list
  the refusal cases of a command exactly, without absolute claims.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (a real local server only).
