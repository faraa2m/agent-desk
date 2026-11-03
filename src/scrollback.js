/** Bounded text buffer that keeps the most recent `maxBytes` bytes of output. */
export class Scrollback {
  #buf = Buffer.alloc(0);

  constructor(maxBytes = 1_000_000) {
    this.maxBytes = maxBytes;
  }

  append(chunk) {
    this.#buf = Buffer.concat([this.#buf, Buffer.from(chunk, 'utf8')]);
    if (this.#buf.length > this.maxBytes) {
      this.#buf = this.#buf.subarray(this.#buf.length - this.maxBytes);
    }
  }

  toString() {
    return this.#buf.toString('utf8').replace(/^�+/, '');
  }
}
