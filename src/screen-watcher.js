const ESC = '\x1b';
const BEL = '\x07';
const TAIL_LIMIT = 4096;
const CARRY_LIMIT = 4096;

const PROMPT_PATTERNS = [
  /Do you want to (proceed|make this edit|create|run|allow)/i,
  /Enter to select/,
  /❯\s*1\.\s+Yes/,
];

const ANSI_PATTERN = new RegExp(
  [
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC
    '\\x1b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\x1b[ -/]+[0-~]', // escapes with intermediates, e.g. charset selection
    '\\x1b[@-Z\\\\-_a-z=>]', // two-character escapes
  ].join('|'),
  'g',
);

export function stripAnsi(s) {
  return s.replace(ANSI_PATTERN, '');
}

export function detectPrompt(text) {
  return PROMPT_PATTERNS.some((re) => re.test(text));
}

// OSC 9;4 is the terminal progress-bar sequence, not a notification.
function isNotificationOsc(body) {
  if (body.startsWith('9;')) return !/^9;4(;|$)/.test(body);
  return body.startsWith('777;');
}

/**
 * Scans raw terminal output for signs that the session is waiting on the user:
 * a prompt in the visible text, a bell, or an OSC 9 / OSC 777 notification.
 * An escape sequence split across feed() calls is held back and parsed once
 * the rest arrives.
 */
export class ScreenWatcher {
  #carry = '';
  #tail = '';
  #bellPending = false;

  feed(chunk) {
    const s = this.#carry + chunk;
    this.#carry = '';
    let text = '';
    let i = 0;

    while (i < s.length) {
      const c = s[i];
      if (c === BEL) {
        this.#bellPending = true;
        i += 1;
        continue;
      }
      if (c !== ESC) {
        text += c;
        i += 1;
        continue;
      }
      const end = this.#sequenceEnd(s, i);
      if (end === -1) {
        const rest = s.slice(i);
        if (rest.length <= CARRY_LIMIT) this.#carry = rest;
        break;
      }
      i = end;
    }

    if (text) this.#tail = (this.#tail + text).slice(-TAIL_LIMIT);
  }

  // Returns the index just past the escape sequence starting at `start`, or -1
  // if the sequence is not complete yet. Notification OSCs set the bell flag.
  #sequenceEnd(s, start) {
    if (start + 1 >= s.length) return -1;
    const kind = s[start + 1];

    if (kind === ']') {
      for (let j = start + 2; j < s.length; j += 1) {
        const ch = s[j];
        if (ch === BEL || ch === ESC) {
          if (ch === ESC) {
            if (j + 1 >= s.length) return -1;
            if (s[j + 1] !== '\\') return j; // another sequence begins; abandon this OSC
          }
          if (isNotificationOsc(s.slice(start + 2, j))) this.#bellPending = true;
          return ch === BEL ? j + 1 : j + 2;
        }
      }
      return -1;
    }

    if (kind === '[') {
      for (let j = start + 2; j < s.length; j += 1) {
        const code = s.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) return j + 1;
      }
      return -1;
    }

    if (kind >= ' ' && kind <= '/') {
      for (let j = start + 2; j < s.length; j += 1) {
        const code = s.charCodeAt(j);
        if (code < 0x20 || code > 0x2f) return j + 1;
      }
      return -1;
    }

    return start + 2;
  }

  userInput() {
    this.#bellPending = false;
    this.#tail = '';
  }

  get waiting() {
    return this.#bellPending || detectPrompt(this.#tail);
  }
}
