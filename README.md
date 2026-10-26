# gladys-roth-touchline

[Gladys Assistant](https://gladysassistant.com) external integration for the
**Roth Touchline** underfloor heating, through its **Ethernet controller** on
the local network (the two CGI scripts of the controller, no account, no
password): one device per room thermostat with its temperature, setpoint,
mode and week program, and three kinds of commands (setpoint, mode, program)
behind two off-by-default options, bounded by the limits of the controller
and a ceiling (24 °C by default, 30 °C at most). **Not Touchline SL** (the
cloud range, see `gladys-touchline-sl`). **Never tested with a real device.
Not affiliated with Roth.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (TouchlineApp)
                                  ├─ src/touchline/client.js  count, device, write (echo), one request at a time
                                  ├─ src/touchline/http.js    node:http, deadline, 64 KB cap, `sent`, beforeSend
                                  ├─ src/touchline/xml.js     the XML request and answers, read linearly, bounded
                                  ├─ src/touchline/model.js   answers -> checked values (pytouchline shapes)
                                  ├─ src/devices.js           the room devices and their states (pure)
                                  ├─ src/store.js             /data: last attempt, pause, last write (no address)
                                  └─ src/publisher.js         states within 300/min
```

- **Reads**: `POST /cgi-bin/ILRReadValues.cgi` for `totalNumberOfDevices`,
  then for the nine parameters of each device `G<i>` (name, setpoint limits,
  week program, mode, setpoint, room temperature, `kurzID`, `ownerKurzID`),
  every 60 s (30 s – 10 min), one request at a time, a round bounded to
  45 s. Answers capped at 64 KB and 64 items, read without an XML parser,
  every value checked (plain integers, plausible temperatures).
- **Pace**: never two reads within the interval, whatever asks (the time of
  the last attempt is kept in `/data`); the clock is read once per decision
  (`dueAt(mono)`), on a monotonic clock; a real-clock test proves the reads
  start.
- **Failures**: the count failing pauses 1, 2, 5, 10, 15 min (never under
  the interval), kept in `/data` for the reads, the button and the commands;
  a device failing leaves only that device unread; an internal error never
  leaves the integration without a timer.
- **Devices**: `ext:<selector>:touchline:<ownerKurzID>-<kurzID>`; the
  position `G<i>` is checked at every read and before every command; two
  devices with the same ids in one round are not trusted; a created device
  is never dropped from Discovery nor loses a feature. Temperature
  `temperature-sensor/decimal` °C, setpoint `thermostat/target-temperature`
  °C (5–30), mode and program `text/select` with string options. No switch.
- **Commands**: off by default (`allow_setpoints`, `allow_modes`); a fresh
  read of the device within 2.5 s, ids checked, bounds = the limits of the
  device within 5 °C and the ceiling, checked again in `beforeSend`; the
  write (`GET /cgi-bin/writeVal.cgi?G<i>.<parameter>=<value>`) leaves by
  3.5 s or is refused unsent; the echo confirms; a write that may have left
  is "sent, without confirmation"; follow-up reads at 5 s and 20 s; one
  command at a time, 3 s apart.

## Development

```bash
npm install
npm test            # node --test (Node 22 and 24 in the CI)
npm run lint
npm run format:check
npm run audit
npm run cover       # cover.png (800x534), plain Node
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits

Protocol ported from
[pytouchline_extended](https://github.com/brondum/pytouchline) 1.1.2 (MIT):
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Licence of this
integration: Apache-2.0.
