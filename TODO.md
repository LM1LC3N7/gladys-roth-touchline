# TODO — Roth Touchline v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, the store validator (`gi ci`), then
  update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core, commands behind options** (2026-10-25): the
      CGI of the controller (count, devices, writes with echo), one device
      per room thermostat keyed by `ownerKurzID-kurzID`, reads paced on a
      monotonic clock (one read of the clock per decision, real-clock test),
      pause in `/data`, per-device isolation and round budget, commands
      (setpoint, mode, program) off by default with fresh read, ids checked,
      bounds of the device and ceiling, `beforeSend`, echo, follow-up reads,
      spacing; test button; en/fr; docs; cover. Tested against a fake
      controller only (Node 22 and 24).
- [ ] **Milestone 2 — real controller**: run against a real Touchline
      Ethernet controller (see "To check"); turn the answers (anonymized)
      into fixtures.
- [ ] **Milestone 3 — first release**: Release workflow, topic, GHCR package
      public.

## To check on a real controller

- **The `client` identification** (see Decisions): the reference sends
  `<client>IMaster6_02_00</client><client_ver>6.02.0006</client_ver>` (the
  identification of the Roth software); this integration sends
  `gladys-roth-touchline` / `1.0`. If the controller refuses or ignores the
  request, the only fix is to send the reference's values, which is an
  imitation of an application and needs Louis's explicit approval (as for
  Sky Q): ask before changing `API.client` in `src/constants.js`.
- The form of a written value: the reference sends `2250.0` for a setpoint
  (`float * 100` printed by Python) and `1` for a mode; this integration does
  the same and accepts an echo of `2250.0` or `2250`. Check what the
  controller echoes and whether `2250` alone is accepted.
- `kurzID` / `ownerKurzID`: whether they are stable across a re-pairing of a
  thermostat and unique on one controller (two devices with the same ids are
  not trusted here); whether `ownerKurzID` differs between several
  controllers on one network (one integration reads one controller anyway).
- Whether one read request may list the items of several devices at once
  (the reference asks one device per request; one request per device here).
- The `OPMode` and `WeekProg` codes beyond 0–2 / 0–3 (a code outside the
  list publishes nothing for its select); whether a mode written while a
  program is active is applied or overridden by the program.
- The names: UTF-8 or Latin-1 (both read).
- The CGI timing (10 s timeout per request, 45 s per round, 32 devices at
  most): enough for a controller with many thermostats?
- `SollTempMinVal` / `SollTempMaxVal`: present on every device (a command is
  refused without them)?

## Planned manifest fields (gladys_version >= 5.3.0)

- `keywords`: `["roth", "touchline", "underfloor heating", "plancher chauffant", "thermostat"]`
- `countries`: `["DE", "AT", "CH", "FR", "NL", "BE", "DK", "SE", "PL"]`
  To add with the migration to SDK 0.16 and `gladys_version: ">=5.3.0"`.

## Decisions

- **Not a duplicate** (lot 16, line 8 of `_lots/lot16/proposition.md`):
  Touchline (Ethernet controller) is distinct from Touchline SL (cloud,
  `LM1LC3N7/gladys-touchline-sl`); the docs say so.
- **Reference reused: pytouchline_extended 1.1.2** (MIT, `brondum/pytouchline`
  on GitHub, LICENSE "Copyright (c) 2017 abondoe"; the library of the Home
  Assistant `touchline` integration), cloned read only in
  `~/code/ref/lot16/pytouchline_extended` (commit dc510d7). Python: ported,
  credited in the README and `THIRD_PARTY_NOTICES.md` (full MIT notice,
  copied into the image). Only runtime dependency: the SDK.
- **SDK ^0.15.0**: 0.16.0 was tagged but not on npm on 2026-10-25
  (`npm view` gave 0.15.0): `package.json` and the lock were moved from the
  template's `^0.16.0` to `^0.15.0`. Migration to 0.16 with the planned
  wave (keywords, countries, `gladys_version >= 5.3.0`).
- **No `poll_frequency`**: the neighbour modules keep their own read loop;
  the core's `device.poll` would not give the pacing kept across restarts.
- **Neighbour modules**: `gladys-touchline-sl` (commands behind options,
  fresh read, `beforeSend`, follow-ups, publisher), `gladys-ta-cmi` (local
  HTTP, status, badges, store), `gladys-iskra` 7ea6ab1 (clock: `dueAt(mono)`,
  test clock that moves at every read, real-clock test).
- **Client identification**: the read request says `gladys-roth-touchline`,
  not the Roth software (`IMaster6_02_00`), because imitating an application
  is forbidden without Louis's explicit approval. Risk: an unverified
  controller may expect the reference's values (see "To check"); said in
  the docs.
- **Never `CD.upass`**: the reference reads the controller's web password
  with every device; this integration never asks it, never logs it.
- **Identity**: `ext:<selector>:touchline:<ownerKurzID>-<kurzID>`, the two
  ids the controller reports; the position `G<i>` moves when a device is
  removed, so it is only a parameter, checked at every round and before every
  command (the fresh read at the last known position must report the
  target's ids, else "another device answers at this position"). A device
  without readable ids is not published; two devices with the same ids in one
  round are both left unread (never mixed).
- **Features**: temperature `temperature-sensor/decimal` °C; setpoint
  `thermostat/target-temperature` °C, min 5, max 30; mode and week program
  `text/select` with string values (`normal`/`night`/`holiday`,
  `none`/`program-1..3`) and string labels (tested against the core's
  `normalizeSupportedOptions` when present). Not `thermostat/preset`: the
  core enum cannot tell three programs apart, and Home Assistant's combined
  presets would need two writes per command; two selects map one to one on
  `OPMode` and `WeekProg`, one write each. No operating state: the controller
  does not report whether a zone heats. No switch, no writable binary.
- **Commands** (brief: setpoints bounded to the manufacturer's limits at
  most, modes off by default): both options off by default; the bounds of a
  setpoint are the device's `SollTempMinVal`/`SollTempMaxVal` (never
  written), within 5–30 °C and the ceiling (24 °C default, 16–30); a
  command is refused when the limits are unreadable. There is no off
  command on Touchline: no protective command exists, lowering is a command
  like the others (docs list the refusal cases exactly). Fresh read within
  2.5 s, ids checked, `beforeSend` re-checks the option, the ceiling, the
  limits, the session and the 3.5 s deadline; the echo of the value is the
  confirmation (the reference's check); no echo or a dropped answer after
  the first byte: "sent, without confirmation" (never "not sent"); a 4xx:
  "the controller refused"; follow-up reads of that device at 5 s and 20 s
  (not a full round); one command at a time, 3 s after a write that left
  (kept in `/data` so a restart keeps the spacing). The command's requests
  go through the same one-at-a-time client as the round: the round yields to
  a command between two devices; the command's deadlines bound its wait.
- **Written values**: clean integers (`2250.0` for a setpoint as the
  reference prints a float, `1` for a mode); the reference's float
  arithmetic (`22.1*100 = 2210.0000000000005`) is not reproduced.
- **Pace**: `lastReadAt` on the monotonic clock, `dueAt(mono)` from the
  caller's instant; the time of the last attempt is kept in `/data` before
  the read (at most once a minute) and brought onto the monotonic clock at
  start; the test button, a scan, a config save or a reconnection never read
  sooner; the test button answers "next one possible in …" instead.
- **Failures**: the count failing = the round failed: pause of
  max(interval, 1/2/5/10/15 min), capped to 1 h, kept in `/data` (wall
  clock, capped when read back), badges unreachable, status "not read"; a
  device failing (timeout, bad answer, absent) only leaves that device
  unread (listed in the status, degraded badge); a round over 45 s leaves
  the rest for the next one; an internal error pauses one interval and
  schedules the next read; a reconnection to Gladys clears nothing.
- **`/data`**: `lastAttemptAt`, `key` (hash of address and port), `pause`,
  `lastWriteAt`; never the address nor any secret; 0600; 64 KB read cap.
- **Freshness**: states are published from the round that read them;
  nothing is published for an unread device or an unreadable value;
  unchanged values are sent again every 30 min by the publisher heartbeat.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the template's 1.0.0 replaced); the
  first patch release gives 0.1.1.
- **LICENSE**: the standard Apache-2.0 text (appendix placeholder, no
  personal name); `THIRD_PARTY_NOTICES.md` credits pytouchline_extended with
  its full MIT notice; both copied into the image.
- **Cover**: `cover.png` 800×534 generated by `scripts/cover.mjs` (plain
  Node, no dependency).
- **Template demo files removed** (devices, scenes, widgets, weather and
  their tests).
