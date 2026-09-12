/**
 * KittyFlagsTracker - Tracks kitty keyboard protocol enhancement flags.
 *
 * Programs using the kitty keyboard protocol (e.g. emacs kkp-mode, nvim)
 * manage their enhancement flags through CSI-u sequences in the terminal
 * OUTPUT stream (program -> terminal):
 *
 *   CSI ? u                query current flags (no state change)
 *   CSI > flags u           push: save current flags, set new
 *   CSI < count u           pop: restore saved flags (count defaults to 1)
 *   CSI = flags [; mode] u  set: mode 1 replace (default), mode 2 union
 *
 * While flags are active, the terminal should encode keys using kitty
 * CSI-u grammar (see InputHandler). Output data may arrive in arbitrary
 * chunk boundaries, so an incomplete escape sequence at the end of a chunk
 * is carried (bounded) into the next scan.
 *
 * Mirrors the state machine in tty/query-shim.js (server-side counterpart).
 */

const ESC = 0x1b;
const CSI = 0x5b; // [
const FINAL_U = 0x75; // u

/** Max bytes of a split sequence to carry into the next scan. */
const MAX_CARRY = 32;
/** Longer parameter runs are not any recognized kitty sequence. */
const MAX_PARAMS = 16;

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isPrefix(code: number): boolean {
  return (
    code === 0x3f /* ? */ ||
    code === 0x3e /* > */ ||
    code === 0x3c /* < */ ||
    code === 0x3d /* = */
  );
}

function isParamByte(code: number): boolean {
  return isDigit(code) || code === 0x3b /* ; */;
}

export class KittyFlagsTracker {
  private flags = 0;
  private readonly stack: number[] = [];
  private carry = '';

  /** Current active enhancement flags (0 = kitty protocol inactive). */
  get currentFlags(): number {
    return this.flags;
  }

  /**
   * Scan a chunk of terminal output for kitty keyboard protocol sequences.
   * Purely observational: never modifies the data.
   */
  scan(data: string | Uint8Array): void {
    if (data === undefined || data === null || data.length === 0) return;

    let s: string;
    if (typeof data === 'string') {
      s = data;
    } else {
      // Binary-safe conversion (escape sequences are ASCII)
      s = '';
      for (let i = 0; i < data.length; i++) {
        s += String.fromCharCode(data[i]);
      }
    }
    if (this.carry.length > 0) {
      s = this.carry + s;
      this.carry = '';
    }

    const len = s.length;
    let i = 0;
    while (i < len) {
      if (s.charCodeAt(i) !== ESC) {
        i += 1;
        continue;
      }

      // ESC at the very end: could be the start of a split sequence
      if (i + 1 >= len) {
        this.saveCarry(s, i);
        return;
      }

      // Only CSI sequences are recognized
      if (s.charCodeAt(i + 1) !== CSI) {
        // RIS (full terminal reset, ESC c) resets the kitty flag stack
        // per the kitty keyboard protocol specification.
        if (s.charCodeAt(i + 1) === 0x63 /* c */) {
          this.flags = 0;
          this.stack.length = 0;
        }
        i += 1;
        continue;
      }

      const paramsStart = i + 2;
      let k = paramsStart;
      let finalByte = -1;
      let invalid = false;

      while (k < len) {
        const b = s.charCodeAt(k);
        if (b === FINAL_U) {
          finalByte = b;
          break;
        }
        if (k - paramsStart >= MAX_PARAMS) {
          invalid = true;
          break;
        }
        if (isParamByte(b) || (k === paramsStart && isPrefix(b))) {
          k += 1;
          continue;
        }
        invalid = true;
        break;
      }

      if (finalByte !== -1) {
        this.handleSequence(s.slice(paramsStart, k));
        i = k + 1;
        continue;
      }

      if (invalid) {
        i = k;
        continue;
      }

      // Reached the end of the chunk mid-sequence: carry if bounded
      this.saveCarry(s, i);
      return;
    }
  }

  private handleSequence(params: string): void {
    if (params.length === 0 || params === '?') return; // query: no state change

    if (params[0] === '>') {
      // push: save current flags, set new
      const next = Number.parseInt(params.slice(1), 10);
      if (Number.isFinite(next)) {
        this.stack.push(this.flags);
        this.flags = next;
      }
      return;
    }

    if (params[0] === '<') {
      // pop: restore saved flags (count defaults to 1; empty stack is a no-op)
      let count = Number.parseInt(params.slice(1), 10);
      if (!Number.isFinite(count) || count < 1) count = 1;
      for (let n = 0; n < count; n++) {
        if (this.stack.length > 0) {
          this.flags = this.stack.pop() as number;
        }
      }
      return;
    }

    if (params[0] === '=') {
      // set: mode 1 replace (default), mode 2 union
      const match = /^(\d+)(?:;(\d+))?$/.exec(params.slice(1));
      if (!match) return;
      const value = Number.parseInt(match[1], 10);
      const mode = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
      this.flags = mode === 2 ? this.flags | value : value;
    }
  }

  private saveCarry(s: string, start: number): void {
    const tail = s.slice(start);
    // Oversized junk is discarded rather than carried forever
    if (tail.length <= MAX_CARRY) this.carry = tail;
  }
}