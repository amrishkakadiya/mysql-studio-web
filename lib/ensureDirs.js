const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');

/** Canonical local data layout:
 *  data/
 *    config/    — SQLite client_config.db
 *    exports/   — batched CSV/JSON exports
 *    scripts/   — saved SQL editor tabs
 */
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

/** @deprecated Use CONFIG_DIR */
const CREDENTIALS_DIR = CONFIG_DIR;

/** Owner-only for secrets / saved SQL. */
const MODE_PRIVATE = 0o700;
/** Owner rwx, group/other rx — export outputs are meant to be opened locally. */
const MODE_EXPORT = 0o755;
const MODE_DATA = 0o755;

/**
 * Create directory if missing, then force mode + current process owner/group.
 * Safe to call repeatedly. chown is best-effort (needs rights; skipped on Windows).
 */
function ensureDir(dirPath, mode = MODE_PRIVATE) {
  const resolved = path.resolve(dirPath);
  fs.mkdirSync(resolved, { recursive: true, mode });

  try {
    fs.chmodSync(resolved, mode);
  } catch (_) {
    /* ignore — e.g. unsupported FS */
  }

  try {
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      const uid = process.getuid();
      const gid = process.getgid();
      if (uid >= 0 && gid >= 0) {
        fs.chownSync(resolved, uid, gid);
      }
    }
  } catch (_) {
    /* ignore — non-root cannot chown others' dirs */
  }

  return resolved;
}

function ensureDataDir() {
  return ensureDir(DATA_DIR, MODE_DATA);
}

function ensureConfigDir() {
  ensureDataDir();
  return ensureDir(CONFIG_DIR, MODE_PRIVATE);
}

/** @deprecated Use ensureConfigDir */
function ensureCredentialsDir() {
  return ensureConfigDir();
}

function ensureScriptsDir() {
  ensureDataDir();
  return ensureDir(SCRIPTS_DIR, MODE_PRIVATE);
}

function ensureExportDir() {
  ensureDataDir();
  return ensureDir(EXPORT_DIR, MODE_EXPORT);
}

/** Bootstrap data/{config,exports,scripts} if missing (startup + lazy use). */
function ensureAppDataDirs() {
  ensureDataDir();
  ensureConfigDir();
  ensureScriptsDir();
  ensureExportDir();
  return {
    data: DATA_DIR,
    config: CONFIG_DIR,
    scripts: SCRIPTS_DIR,
    exports: EXPORT_DIR,
  };
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  CONFIG_DIR,
  SCRIPTS_DIR,
  EXPORT_DIR,
  CREDENTIALS_DIR,
  MODE_PRIVATE,
  MODE_EXPORT,
  MODE_DATA,
  ensureDir,
  ensureDataDir,
  ensureConfigDir,
  ensureCredentialsDir,
  ensureScriptsDir,
  ensureExportDir,
  ensureAppDataDirs,
};
