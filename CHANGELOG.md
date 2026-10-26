# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-26

### Added

- Roth Touchline underfloor heating through its Ethernet controller (local
  CGI, no account), ported from pytouchline_extended 1.1.2: one device per
  room thermostat with its temperature, setpoint, mode (normal, night,
  holiday) and week program (none, 1, 2, 3).
- Commands off by default: setpoints (`allow_setpoints`), modes and programs
  (`allow_modes`), bounded by the limits of the controller and a ceiling
  (24 °C by default, 16 to 30 °C), decided on a fresh read with the ids of
  the device checked, confirmed by the echo of the controller and a read back
  equal to the value written, read again 5 s and 20 s later (a read back
  that differs is told in the status and the badge); a bounded queue serves
  the commands one at a time, so a scene sets several rooms.
- A read every 60 s (30 s to 10 min), never sooner across restarts; a pause
  of 1 to 15 min after a failed read, kept in `/data`; a device that does
  not answer leaves the others read; a long round resumes where it stopped
  and the controller rests between rounds; the configuration of Gladys is
  read again when it fails at start.
- "Test the connection" button; the status, the Discovery list and the
  transport badges are sent again at each reconnection to Gladys.
- Device, feature and option names in French or English.
- Distinct from Touchline SL (the cloud range): said in the docs.

[Unreleased]: https://github.com/LM1LC3N7/gladys-roth-touchline/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-roth-touchline/releases/tag/v0.1.1
