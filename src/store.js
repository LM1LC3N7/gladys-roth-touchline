// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded when read back: the time of the last read attempt (a
// restart never reads sooner than the interval), and, for the controller it
// belongs to (a hash of its address and port), the pause after failed reads
// and the time of the last write (writes stay spaced across a restart). No
// secret exists in this integration; the address itself is never written.
// A small JSON file, written through a temporary file and a rename, one save
// after the other. The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/roth-touchline-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
        throw new Error('state file too large');
      }
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);

/**
 * The persisted state, repaired; the end of a pause is capped from `now`
 * (wall clock), so a clock jump or a hand-edited file never stops for good.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const lastAttemptAt = time(raw?.lastAttemptAt);
  const key = typeof raw?.key === 'string' && /^[0-9a-f]{32}$/.test(raw.key) ? raw.key : '';
  const p = raw?.pause;
  const pause =
    key && p && typeof p === 'object' && time(p.until)
      ? {
          until: Math.min(p.until, now + TIMINGS.pauseMax),
          failures: Number.isInteger(p.failures) && p.failures >= 0 ? Math.min(p.failures, 10) : 0,
        }
      : null;
  const lastWriteAt = key ? time(raw?.lastWriteAt) : undefined;
  return {
    lastAttemptAt: lastAttemptAt === undefined ? null : Math.min(lastAttemptAt, now),
    key,
    pause,
    lastWriteAt: lastWriteAt === undefined ? null : Math.min(lastWriteAt, now),
  };
}
