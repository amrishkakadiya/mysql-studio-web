const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const {
  CONFIG_DIR,
  CREDENTIALS_DIR,
  ensureConfigDir,
} = require('./ensureDirs');

const DB_PATH = path.join(CONFIG_DIR, 'client_config.db');

const DEFAULT_KEEP_ALIVE_INTERVAL = 120;
const MIN_KEEP_ALIVE_INTERVAL = 15;
const MAX_KEEP_ALIVE_INTERVAL = 3600;
const DEFAULT_ROW_LIMIT = 100;
const MIN_ROW_LIMIT = 10;
const MAX_ROW_LIMIT = 1000;

/** @type {import('better-sqlite3').Database | null} */
let sqlite = null;

/** @type {Map<number, import('mysql2/promise').Pool>} */
const pools = new Map();

/** @type {Map<number, NodeJS.Timeout>} */
const keepAliveTimers = new Map();

function tableHasColumn(table, column) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function migrateConnectionColumns() {
  if (!tableHasColumn('connections', 'keep_alive')) {
    sqlite.exec(
      `ALTER TABLE connections ADD COLUMN keep_alive INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!tableHasColumn('connections', 'keep_alive_interval_sec')) {
    sqlite.exec(
      `ALTER TABLE connections ADD COLUMN keep_alive_interval_sec INTEGER NOT NULL DEFAULT ${DEFAULT_KEEP_ALIVE_INTERVAL}`
    );
  }
  if (!tableHasColumn('connections', 'row_limit')) {
    sqlite.exec(
      `ALTER TABLE connections ADD COLUMN row_limit INTEGER NOT NULL DEFAULT ${DEFAULT_ROW_LIMIT}`
    );
  }
}

function normalizeKeepAliveInterval(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return DEFAULT_KEEP_ALIVE_INTERVAL;
  return Math.min(
    MAX_KEEP_ALIVE_INTERVAL,
    Math.max(MIN_KEEP_ALIVE_INTERVAL, Math.round(n))
  );
}

function normalizeKeepAliveFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function normalizeRowLimit(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return DEFAULT_ROW_LIMIT;
  return Math.min(MAX_ROW_LIMIT, Math.max(MIN_ROW_LIMIT, Math.round(n)));
}

function mapConnectionRow(row) {
  if (!row) return null;
  return {
    ...row,
    keep_alive: Boolean(row.keep_alive),
    keep_alive_interval_sec: normalizeKeepAliveInterval(
      row.keep_alive_interval_sec ?? DEFAULT_KEEP_ALIVE_INTERVAL
    ),
    row_limit: normalizeRowLimit(row.row_limit ?? DEFAULT_ROW_LIMIT),
  };
}

function initDb() {
  if (sqlite) return sqlite;

  ensureConfigDir();

  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 3306,
      user TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      database_name TEXT,
      theme_color TEXT NOT NULL DEFAULT '#3B82F6',
      keep_alive INTEGER NOT NULL DEFAULT 0,
      keep_alive_interval_sec INTEGER NOT NULL DEFAULT ${DEFAULT_KEEP_ALIVE_INTERVAL},
      row_limit INTEGER NOT NULL DEFAULT ${DEFAULT_ROW_LIMIT},
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS query_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER,
      sql_text TEXT NOT NULL,
      duration_ms REAL,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (connection_id) REFERENCES connections(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    DROP TABLE IF EXISTS saved_snippets;
  `);

  migrateConnectionColumns();

  return sqlite;
}

function getDb() {
  if (!sqlite) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return sqlite;
}

function closeSqlite() {
  if (!sqlite) return;
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    // ignore checkpoint errors during shutdown
  }
  sqlite.close();
  sqlite = null;
}

function stripPassword(row) {
  if (!row) return null;
  const mapped = mapConnectionRow(row);
  const { password, ...rest } = mapped;
  return rest;
}

const CONNECTION_SELECT = `
  id, nickname, host, port, user, password, database_name, theme_color,
  keep_alive, keep_alive_interval_sec, row_limit, created_at, updated_at
`;

const CONNECTION_SELECT_PUBLIC = `
  id, nickname, host, port, user, database_name, theme_color,
  keep_alive, keep_alive_interval_sec, row_limit, created_at, updated_at
`;

function getConnections() {
  return getDb()
    .prepare(
      `SELECT ${CONNECTION_SELECT_PUBLIC}
       FROM connections
       ORDER BY nickname COLLATE NOCASE`
    )
    .all()
    .map(mapConnectionRow);
}

function getConnection(id, { includePassword = false } = {}) {
  const row = getDb()
    .prepare(
      `SELECT ${CONNECTION_SELECT}
       FROM connections
       WHERE id = ?`
    )
    .get(id);

  if (!row) return null;
  return includePassword ? mapConnectionRow(row) : stripPassword(row);
}

function getConnectionWithPassword(id) {
  return getConnection(id, { includePassword: true });
}

function createConnection(data) {
  const result = getDb()
    .prepare(
      `INSERT INTO connections (
         nickname, host, port, user, password, database_name, theme_color,
         keep_alive, keep_alive_interval_sec, row_limit
       ) VALUES (
         @nickname, @host, @port, @user, @password, @database_name, @theme_color,
         @keep_alive, @keep_alive_interval_sec, @row_limit
       )`
    )
    .run({
      nickname: data.nickname,
      host: data.host,
      port: data.port ?? 3306,
      user: data.user,
      password: data.password ?? '',
      database_name: data.database_name ?? null,
      theme_color: data.theme_color || '#3B82F6',
      keep_alive: normalizeKeepAliveFlag(data.keep_alive),
      keep_alive_interval_sec: normalizeKeepAliveInterval(
        data.keep_alive_interval_sec ?? DEFAULT_KEEP_ALIVE_INTERVAL
      ),
      row_limit: normalizeRowLimit(data.row_limit ?? DEFAULT_ROW_LIMIT),
    });

  return getConnection(result.lastInsertRowid);
}

function updateConnection(id, data) {
  const existing = getConnectionWithPassword(id);
  if (!existing) return null;

  const password =
    data.password === undefined || data.password === null || data.password === ''
      ? existing.password
      : data.password;

  const keepAlive = normalizeKeepAliveFlag(
    data.keep_alive !== undefined ? data.keep_alive : existing.keep_alive
  );
  const keepAliveInterval = normalizeKeepAliveInterval(
    data.keep_alive_interval_sec !== undefined
      ? data.keep_alive_interval_sec
      : existing.keep_alive_interval_sec
  );

  getDb()
    .prepare(
      `UPDATE connections
       SET nickname = @nickname,
           host = @host,
           port = @port,
           user = @user,
           password = @password,
           database_name = @database_name,
           theme_color = @theme_color,
           keep_alive = @keep_alive,
           keep_alive_interval_sec = @keep_alive_interval_sec,
           row_limit = @row_limit,
           updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({
      id,
      nickname: data.nickname,
      host: data.host,
      port: data.port ?? 3306,
      user: data.user,
      password,
      database_name: data.database_name ?? null,
      theme_color: data.theme_color || '#3B82F6',
      keep_alive: keepAlive,
      keep_alive_interval_sec: keepAliveInterval,
      row_limit: normalizeRowLimit(data.row_limit ?? existing.row_limit),
    });

  const credentialsChanged =
    existing.host !== data.host ||
    Number(existing.port) !== Number(data.port ?? 3306) ||
    existing.user !== data.user ||
    existing.password !== password ||
    (existing.database_name || null) !== (data.database_name ?? null);

  if (credentialsChanged) {
    void closePool(id);
  } else if (pools.has(id)) {
    syncKeepAlive(id);
  }

  return getConnection(id);
}

function deleteConnection(id) {
  void closePool(id);
  const result = getDb().prepare('DELETE FROM connections WHERE id = ?').run(id);
  return result.changes > 0;
}

function buildMysqlConfig(config) {
  const cfg = {
    host: config.host,
    port: Number(config.port) || 3306,
    user: config.user,
    password: config.password ?? '',
    waitForConnections: true,
    connectionLimit: 5,
    enableKeepAlive: true,
    connectTimeout: 10000,
  };

  if (config.database_name) {
    cfg.database = config.database_name;
  }

  return cfg;
}

async function testConnection(config) {
  const connection = await mysql.createConnection(buildMysqlConfig(config));
  try {
    await connection.ping();
    return { ok: true, message: 'Connection successful' };
  } finally {
    await connection.end();
  }
}

function hasPool(connectionId) {
  return pools.has(Number(connectionId));
}

function stopKeepAlive(connectionId) {
  const id = Number(connectionId);
  const timer = keepAliveTimers.get(id);
  if (timer) {
    clearInterval(timer);
    keepAliveTimers.delete(id);
  }
}

function syncKeepAlive(connectionId) {
  const id = Number(connectionId);
  stopKeepAlive(id);

  if (!pools.has(id)) return;

  const config = getConnectionWithPassword(id);
  if (!config || !config.keep_alive) return;

  const intervalSec = normalizeKeepAliveInterval(config.keep_alive_interval_sec);
  const timer = setInterval(() => {
    const pool = pools.get(id);
    if (!pool) {
      stopKeepAlive(id);
      return;
    }
    pool
      .query('SELECT 1')
      .catch((err) => {
        console.warn(
          `[keep-alive] connection ${id} ping failed: ${err.message}`
        );
      });
  }, intervalSec * 1000);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  keepAliveTimers.set(id, timer);
}

async function getPool(connectionId) {
  const id = Number(connectionId);
  if (pools.has(id)) {
    syncKeepAlive(id);
    return pools.get(id);
  }

  const config = getConnectionWithPassword(id);
  if (!config) {
    throw new Error(`Connection ${id} not found`);
  }

  const pool = mysql.createPool(buildMysqlConfig(config));

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }

  pools.set(id, pool);
  syncKeepAlive(id);
  return pool;
}

async function closePool(connectionId) {
  const id = Number(connectionId);
  stopKeepAlive(id);
  const pool = pools.get(id);
  if (!pool) return;

  pools.delete(id);
  await pool.end().catch(() => {});
}

async function closeAllPools() {
  const ids = [...pools.keys()];
  await Promise.all(ids.map((id) => closePool(id)));
}

const HISTORY_MAX_ROWS = 500;
const HISTORY_DEFAULT_LIMIT = 100;

function addQueryHistory({
  connectionId = null,
  sqlText,
  durationMs = null,
  status = 'ok',
  errorMessage = null,
} = {}) {
  const db = getDb();
  const sql = String(sqlText || '').trim();
  if (!sql) return null;

  const result = db
    .prepare(
      `INSERT INTO query_history (connection_id, sql_text, duration_ms, status, error_message)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      connectionId == null ? null : Number(connectionId),
      sql.slice(0, 200_000),
      durationMs == null ? null : Number(durationMs),
      status === 'error' ? 'error' : 'ok',
      errorMessage ? String(errorMessage).slice(0, 4000) : null
    );

  // Keep the table bounded so local SQLite stays small.
  db.prepare(
    `DELETE FROM query_history
     WHERE id NOT IN (
       SELECT id FROM query_history ORDER BY id DESC LIMIT ?
     )`
  ).run(HISTORY_MAX_ROWS);

  return getQueryHistoryById(result.lastInsertRowid);
}

function getQueryHistoryById(id) {
  return (
    getDb()
      .prepare(
        `SELECT id, connection_id, sql_text, duration_ms, status, error_message, created_at
         FROM query_history WHERE id = ?`
      )
      .get(Number(id)) || null
  );
}

function listQueryHistory({ connectionId = null, limit = HISTORY_DEFAULT_LIMIT } = {}) {
  const db = getDb();
  const capped = Math.min(
    HISTORY_DEFAULT_LIMIT,
    Math.max(1, Math.round(Number(limit) || HISTORY_DEFAULT_LIMIT))
  );
  const id = connectionId == null || connectionId === '' ? null : Number(connectionId);

  if (id != null && Number.isInteger(id)) {
    return db
      .prepare(
        `SELECT id, connection_id, sql_text, duration_ms, status, error_message, created_at
         FROM query_history
         WHERE connection_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(id, capped);
  }

  return db
    .prepare(
      `SELECT id, connection_id, sql_text, duration_ms, status, error_message, created_at
       FROM query_history
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(capped);
}

function deleteQueryHistory(id) {
  const result = getDb()
    .prepare(`DELETE FROM query_history WHERE id = ?`)
    .run(Number(id));
  return result.changes > 0;
}

function clearQueryHistory({ connectionId = null } = {}) {
  const db = getDb();
  const id = connectionId == null || connectionId === '' ? null : Number(connectionId);
  if (id != null && Number.isInteger(id)) {
    return db.prepare(`DELETE FROM query_history WHERE connection_id = ?`).run(id).changes;
  }
  return db.prepare(`DELETE FROM query_history`).run().changes;
}

const DEFAULT_APP_SETTINGS = {
  ui_font_family: 'ui-sans-serif, system-ui, sans-serif',
  ui_font_size: '14',
  editor_font_family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  editor_font_size: '13',
};

function getAppSettings() {
  const db = getDb();
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all();
  const settings = { ...DEFAULT_APP_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_APP_SETTINGS) {
      settings[row.key] = String(row.value ?? DEFAULT_APP_SETTINGS[row.key]);
    }
  }
  return settings;
}

function updateAppSettings(patch = {}) {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (@key, @value, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now')`
  );

  const next = { ...getAppSettings() };
  for (const key of Object.keys(DEFAULT_APP_SETTINGS)) {
    if (patch[key] === undefined || patch[key] === null) continue;
    let value = String(patch[key]).trim();
    if (key.endsWith('_font_size')) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) continue;
      value = String(Math.min(24, Math.max(10, n)));
    }
    if (!value) continue;
    next[key] = value;
    upsert.run({ key, value });
  }
  return next;
}

module.exports = {
  CONFIG_DIR,
  CREDENTIALS_DIR,
  DB_PATH,
  DEFAULT_KEEP_ALIVE_INTERVAL,
  MIN_KEEP_ALIVE_INTERVAL,
  MAX_KEEP_ALIVE_INTERVAL,
  DEFAULT_ROW_LIMIT,
  MIN_ROW_LIMIT,
  MAX_ROW_LIMIT,
  HISTORY_MAX_ROWS,
  DEFAULT_APP_SETTINGS,
  initDb,
  getDb,
  closeSqlite,
  getConnections,
  getConnection,
  getConnectionWithPassword,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  hasPool,
  getPool,
  closePool,
  closeAllPools,
  syncKeepAlive,
  addQueryHistory,
  listQueryHistory,
  deleteQueryHistory,
  clearQueryHistory,
  getAppSettings,
  updateAppSettings,
};
