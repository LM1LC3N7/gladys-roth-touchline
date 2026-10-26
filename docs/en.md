# Roth Touchline for Gladys

This integration shows the rooms (room thermostats) of your **Roth Touchline**
underfloor heating in Gladys, through the **Touchline Ethernet controller** on
your local network. It talks to the controller directly, without any account
or password, through the two CGI scripts the controller exposes (reading and
writing values).

**This is not Touchline SL**: Touchline SL is the newer Roth range, driven by
a cloud service with a Roth account; it has its own integration ("Roth
Touchline SL"). If your Roth app asks for an account, you have Touchline SL.

**Never tested with a real device**: it follows the pytouchline_extended
library (the one of the Home Assistant `touchline` integration), without
having been tried on a real installation. Tell us on the forum whether it
works for you. **Not affiliated with Roth.**

## What it does

For each room the controller knows, a device "Room name (Touchline)" with:

- the room temperature (read only);
- the setpoint (thermostat);
- the mode: normal, night or holiday (a list);
- the week program: none, 1, 2 or 3 (a list).

When a program is active, it decides the mode through the day; "none" lets
the chosen mode apply all the time.

## Setup

1. Install the integration from the Gladys store.
2. Enter the IP address of the Touchline controller (the one of its web
   interface), then save.
3. Open the **Discovery** tab and add the rooms you want.

The **Test the connection** button reads the controller once, when the
refresh interval allows it, and shows its status.

Devices are identified by the two numbers the controller gives each
thermostat (the controller's and the thermostat's), not by their position in
the list: removing a thermostat does not mix up the others. A thermostat
whose numbers cannot be read is not offered.

## Commands (off by default)

By default, Gladys only reads. Two separate options:

- **Allow setpoint commands**: the dashboard, the scenes and the voice
  assistants may change the setpoint of a room.
- **Allow mode and program commands**: the "Mode" and "Week program" lists
  may be changed from Gladys.

Safety bounds:

- a setpoint goes from 5 °C to the **setpoint ceiling**, **24 °C by
  default**, adjustable from 16 to 30 °C; the **limits of the controller**
  itself (the minimum and maximum set for the room) apply too, and are never
  changed by Gladys;
- the ceiling, the option and the limits are checked again right before the
  request leaves: if one of them changed during the command, nothing is sent;
- no command goes through a switch: a "turn everything off" of a voice
  assistant does not reach the heating. The Touchline controller has no
  command to stop the heating: lowering the setpoint or choosing the holiday
  mode are commands like the others, behind the same options.

Each command reads the room again right before acting, checks that the
thermostat answering at that position is the one targeted, and decides on
that read; it leaves within 3.5 s or is refused without sending anything. The
controller echoes the value written: that is the confirmation. When the echo
does not come in time, Gladys shows "sent, without confirmation" and reads the
room again 5 s and 20 s later. One command at a time, 3 s apart (the
controller is slow).

A command is refused, with nothing sent, in these cases: option off; value
out of bounds, not a tenth of a degree, or unknown mode/program; room unknown
or another thermostat at its position; reads of the controller paused after
failures; controller too slow; setpoint limits unreadable; another command
running or too recent.

## Limits and safety

- A read every 60 s (30 s to 10 min), every room in turn, one request at a
  time; a room that does not answer leaves the others read; a read starts
  no new room past 45 s, the rest waits for the next one. Never two reads
  within an interval, even across a restart (the time of the last attempt is
  kept in `/data`).
- Controller unreachable: a pause of 1, 2, 5, 10 then 15 min (never under
  the interval), kept in `/data`, for the reads, the button and the commands.
- `/data` holds neither the address of the controller nor any secret (there
  is none): only the time of the last attempt, the pause and the time of the
  last write, tied to a fingerprint of the address.
- The controller gives its web interface password (`CD.upass`) to whoever
  asks: the integration never asks.
- The read request identifies itself as "gladys-roth-touchline", not as the
  Roth software. If your controller does not answer it, tell us on the forum.
- 32 rooms at most per controller.

## Credits

The protocol of the controller and the shape of its answers come from
[pytouchline_extended](https://github.com/brondum/pytouchline) (brondum,
after pytouchline by abondoe, MIT), the library of the Home Assistant
`touchline` integration. See `THIRD_PARTY_NOTICES.md`.
