// -----------------------------------------------------------------------------
// Constants: the CGI of the Roth Touchline controller, the feature roles, the
// manifest keys, the limits and the timings.
//
// Roth Touchline (the Ethernet controller of the Touchline underfloor
// heating, not Touchline SL which is a cloud service) answers two CGI
// scripts on its local address, without any password, as pytouchline_extended
// 1.1.2 (MIT, the library of the Home Assistant `touchline` integration)
// uses them:
//   - POST /cgi-bin/ILRReadValues.cgi, an XML body listing the items wanted
//     (`totalNumberOfDevices`, then `G<i>.<parameter>` for each device <i>),
//     answered by an XML document of `<n>name</n><v>value</v>` pairs;
//   - GET /cgi-bin/writeVal.cgi?G<i>.<parameter>=<value>, answered by the
//     value written (an echo).
// Temperatures travel in hundredths of °C (2250 = 22.50 °C).
// -----------------------------------------------------------------------------

export const API = {
  defaultPort: 80,
  readPath: '/cgi-bin/ILRReadValues.cgi',
  writePath: '/cgi-bin/writeVal.cgi',
  /** The identification sent in the read request: this integration, not the Roth software. */
  client: 'gladys-roth-touchline',
  clientVersion: '1.0',
  countItem: 'totalNumberOfDevices',
  /** The parameters of a device read each round (the reference reads the same, plus `CD.upass`: never here). */
  parameters: [
    'name',
    'SollTempMaxVal',
    'SollTempMinVal',
    'WeekProg',
    'OPMode',
    'SollTemp',
    'RaumTemp',
    'kurzID',
    'ownerKurzID',
  ],
  /** Written by the commands. */
  write: { setpoint: 'SollTemp', mode: 'OPMode', program: 'WeekProg' },
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  TARGET: 'target-temperature',
  MODE: 'mode',
  PROGRAM: 'program',
};

/** The operating modes of a device (`OPMode`), as the reference and Home Assistant read them. */
export const MODES = [
  { value: 'normal', code: 0 },
  { value: 'night', code: 1 },
  { value: 'holiday', code: 2 },
];

/** The week programs of a device (`WeekProg`): none (the mode applies), or one of three. */
export const PROGRAMS = [
  { value: 'none', code: 0 },
  { value: 'program-1', code: 1 },
  { value: 'program-2', code: 2 },
  { value: 'program-3', code: 3 },
];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 30,
  max: 600,
  default: 60,
};

/**
 * The setpoints Gladys may send, in °C: within the limits the controller
 * reports for the device (`SollTempMinVal` / `SollTempMaxVal`), within
 * 5–30 °C whatever they say, and under the configured ceiling (24 °C by
 * default, 16 to 30 °C). The limits of the controller are never written.
 */
export const SETPOINT = {
  min: 5,
  max: 30,
  ceilingMin: 16,
  ceilingDefault: 24,
};

/** A value of `RaumTemp` or `SollTemp` outside this range (°C) is not a measurement. */
export const TEMPERATURE_RANGE = { min: -40, max: 80 };

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer of the controller is read up to this size, then dropped (a device: ~1 KB). */
  responseBytes: 64 * 1024,
  /** Devices read per controller: more are ignored (the count is capped). */
  devices: 32,
  /** Names are cut to this length. */
  nameLength: 60,
  /** Items in an XML answer (one device: 9); beyond, the answer is not ours. */
  items: 64,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (the CGI is slow: the reference waits 10 s). */
  requestTimeout: 10 * SECOND,
  /** A round (the count, then each device) never lasts longer: the devices left wait for the next. */
  roundBudget: 45 * SECOND,
  /** Failed rounds: 1, 2, 5, 10, then 15 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** A pause (backoff) is never longer than this, whatever /data holds. */
  pauseMax: HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads at most this often. */
  testCooldown: 10 * SECOND,
  /** The button waits 30 s in Gladys: it answers by 25 s. */
  testBudget: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_500,
  commandMinSend: 300,
  /** Writes are spaced (the CGI is slow): after a write that may have left, the next command waits. */
  commandSpacing: 3 * SECOND,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
};
