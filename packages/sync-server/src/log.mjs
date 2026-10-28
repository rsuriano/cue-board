// @ts-check
/* One JSON object per line on stderr. LOG_LEVEL: debug | info (default) | warn | error | silent. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(level = 'info') {
  const min = LEVELS[/** @type {keyof LEVELS} */ (level)] ?? LEVELS.info;
  const at = (/** @type {keyof LEVELS} */ lv) => (/** @type {string} */ msg, /** @type {object} */ fields = {}) => {
    if (LEVELS[lv] >= min) process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level: lv, msg, ...fields }) + '\n');
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
