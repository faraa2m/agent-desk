// A node-pty compatible spawn that records calls and returns controllable ptys.
export function makeFakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const dataCbs = [];
    const exitCbs = [];
    const pty = {
      pid: 1000 + calls.length,
      written: [],
      resized: null,
      killed: null,
      onData: (cb) => dataCbs.push(cb),
      onExit: (cb) => exitCbs.push(cb),
      write(s) { this.written.push(s); },
      resize(c, r) { this.resized = [c, r]; },
      kill(sig) { this.killed = sig; },
      emit(s) { dataCbs.forEach((cb) => cb(s)); },
      exit(exitCode = 0) { exitCbs.forEach((cb) => cb({ exitCode })); },
    };
    calls.push({ file, args, opts, pty });
    return pty;
  };
  return { spawn, calls };
}
