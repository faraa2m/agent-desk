// Writes smaller than this are merged into the previous chunk, so a session
// that prints a few bytes at a time does not hold one Buffer per write.
const MERGE_BELOW = 16 * 1024;

/**
 * Bounded text buffer that keeps the most recent `maxBytes` bytes of output.
 * Chunks are kept as a list and joined only when read, so appending costs at
 * most the chunk plus a small tail rather than the whole buffer.
 */
export class Scrollback {
  #chunks = [];
  #size = 0;

  constructor(maxBytes = 1_000_000) {
    this.maxBytes = maxBytes;
  }

  append(chunk) {
    const buf = Buffer.from(chunk, 'utf8');
    if (buf.length === 0) return;
    const last = this.#chunks.at(-1);
    if (last && last.length < MERGE_BELOW) this.#chunks[this.#chunks.length - 1] = Buffer.concat([last, buf]);
    else this.#chunks.push(buf);
    this.#size += buf.length;
    while (this.#chunks.length > 0 && this.#size - this.#chunks[0].length >= this.maxBytes) {
      this.#size -= this.#chunks.shift().length;
    }
  }

  toString() {
    let buf = Buffer.concat(this.#chunks, this.#size);
    if (buf.length > this.maxBytes) {
      buf = buf.subarray(buf.length - this.maxBytes);
      // Keep the trimmed buffer so the next read does not copy the excess again.
      this.#chunks = [buf];
      this.#size = buf.length;
    }
    return buf.toString('utf8').replace(/^�+/, '');
  }
}
