// @ts-check
/* Last resort for errors nothing else caught. Disk errors in timers and socket errors already have their own handlers in
   server.mjs, so anything that lands here is a bug: it is logged as one `error` line starting with "UNCAUGHT" (never
   swallowed), and the process keeps serving. If the same error (name + message + throwing frame) comes back `repeats`
   times within `windowMs`, the process is broken, not unlucky: `onFatal` runs (main.mjs closes and exits 1, so a
   supervisor restarts it). */

/** @param {{ error: (msg: string, fields?: object) => void }} log @param {() => void} onFatal */
export function installSafetyNet(log, onFatal, { repeats = 3, windowMs = 10_000 } = {}) {
  /** @type {Map<string, number[]>} */ const seen = new Map();
  let fatal = false;
  const handler = (/** @type {string} */ kind) => (/** @type {unknown} */ err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const frames = String(e.stack || '').split('\n').slice(1, 6).map(s => s.trim());
    const key = `${e.name}\0${e.message}\0${frames[0] || ''}`, now = Date.now();
    const times = (seen.get(key) || []).filter(t => now - t < windowMs);
    times.push(now); seen.set(key, times);
    if (seen.size > 100) for (const [k, ts] of seen) if (now - ts[ts.length - 1] >= windowMs) seen.delete(k);
    log.error(`UNCAUGHT ${kind}`, { name: e.name, code: /** @type {any} */ (e).code, err: e.message.slice(0, 300), stack: frames, count: times.length });
    if (times.length >= repeats && !fatal) {
      fatal = true;
      log.error(`UNCAUGHT: same error ${repeats} times in ${windowMs / 1000} s, exiting`, { name: e.name });
      onFatal();
    }
  };
  process.on('uncaughtException', handler('uncaughtException'));
  process.on('unhandledRejection', handler('unhandledRejection'));
}
