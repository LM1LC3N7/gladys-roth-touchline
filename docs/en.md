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
that read; it leaves within 3.5 s or is refused without sending anything.
The controller echoes the value written, then the room is **read back**: the
command succeeds only when the value read back is the one asked. When the
echo comes too late to read back within the Gladys delay, Gladys shows "sent
and echoed by the controller: checked by a read in a few seconds"; with no
echo in time, "sent, without confirmation". Either way the room is read
again 5 s and 20 s later (these reads wait their turn, they are never
skipped). When a read back contradicts the echo, the command is told
"without effect" in the status of the integration, the log and the badge of
the room, until the next read. A read made before a write is never
published after it.

Commands wait their turn in a queue (8 at most), one write at a time, 0.5 s
after the answer of the previous one; each keeps its 3.5 s from its arrival.
A scene setting several rooms one after the other sets them all; a scene
setting them at the same time sets a few in a row (6 at most with a fast
controller, fewer with a slow one): beyond, or when a room answers "not sent
in time", leave about 4 s between two rooms.

A command is refused, with nothing sent, in these cases: configuration of
the integration not loaded yet; option off; value out of bounds, not a tenth
of a degree, or unknown mode/program; 8 commands already waiting; reads of
the controller paused after failures; room unknown; no thermostat or another
thermostat at its position; current state unreadable (fresh read failed or
invalid answer); setpoint limits unreadable or inconsistent, or the minimum of the room
above the ceiling; address or
option changed during the command; controller too slow, a read in progress
too long, or too many commands before it to leave in time; connection
refused before sending ("command not sent" and the reason). A write that
left may also come back "the controller refused the command" (a 4xx
answer).

## Limits and safety

- A read every 60 s (30 s to 10 min), every room in turn, one request at a
  time; a room that does not answer leaves the others read; when all fail,
  the read failed (pause below). A read starts no new room past 45 s (and
  never past the interval minus 10 s); the next one starts at the first room
  left unread, so none is forgotten; a room not read again yet keeps its
  last values and stays commandable, its badge turns degraded after two
  reads without it. The controller rests at least half an
  interval between two reads. Never two reads
  within an interval, even across a restart (the time of the last attempt is
  kept in `/data` at each read).
- Configuration of Gladys unreadable at start: new tries after 5 s, 15 s,
  1 min, then every 5 min, with a status saying so.
- A room added or changed in Gladys gets its last values at once only when
  they are fresh (otherwise at the next read).
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
