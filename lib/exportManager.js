const fs = require('node:fs');
const path = require('node:path');
const {
  analyzeSelectSql,
  serializeRows,
} = require('./queryExecutor');
const {
  PROJECT_ROOT,
  EXPORT_DIR: EXPORT_ROOT,
  MODE_EXPORT,
  ensureDir,
  ensureExportDir,
} = require('./ensureDirs');

/** Absolute path to data/exports (alias kept as EXPORT_ROOT). */

const MIN_BATCH = 100;
const MAX_BATCH = 10000;
const DEFAULT_BATCH = 1000;
const MAX_TOTAL_ROWS = 1_000_000;
const MAX_NAME_LENGTH = 80;
const MAX_REL_PATH_LENGTH = 160;

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function ensureExportRoot() {
  return ensureExportDir();
}

function clampBatchSize(value) {
  const n = Math.round(Number(value) || DEFAULT_BATCH);
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, n));
}

/**
 * Normalize a relative folder under data/exports/ (no absolute paths, no traversal).
 */
function normalizeRelativeDir(value) {
  let rel = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.length > MAX_REL_PATH_LENGTH) {
    throw httpError(`Export path is too long (max ${MAX_REL_PATH_LENGTH})`);
  }
  if (rel.includes('\0') || /[<>:"|?*]/.test(rel)) {
    throw httpError('Export path contains invalid characters');
  }
  const parts = rel.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw httpError('Export path cannot contain . or ..');
    }
  }
  return parts.join('/');
}

function normalizeBaseName(value, fallback = 'export') {
  let name = String(value || '').trim();
  if (!name) name = fallback;
  name = name
    .replace(/\.(csv|json)$/i, '')
    .replace(/[<>:"/\\|?*\0-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = fallback;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);
  return name;
}

function resolveExportDir(relativeDir) {
  ensureExportRoot();
  const rel = normalizeRelativeDir(relativeDir);
  const target = rel ? path.join(EXPORT_ROOT, rel) : EXPORT_ROOT;
  const resolved = path.resolve(target);
  const rootResolved = path.resolve(EXPORT_ROOT);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw httpError('Export path escapes data/exports folder', 400);
  }
  ensureDir(resolved, MODE_EXPORT);
  return { relativeDir: rel, absoluteDir: resolved };
}

function resolveSafeFile(relativePath) {
  ensureExportRoot();
  const rel = String(relativePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.includes('..')) {
    throw httpError('Invalid file path', 400);
  }
  const absolute = path.resolve(EXPORT_ROOT, rel);
  const rootResolved = path.resolve(EXPORT_ROOT);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw httpError('File path escapes data/exports folder', 400);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw httpError('File not found', 404);
  }
  return { relativePath: path.relative(EXPORT_ROOT, absolute).split(path.sep).join('/'), absolutePath: absolute };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(columns, rows, { header = true } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const data = Array.isArray(rows) ? rows : [];
  const lines = [];
  if (header) lines.push(cols.map((c) => csvCell(c)).join(','));
  for (const row of data) {
    lines.push(cols.map((col) => csvCell(row?.[col])).join(','));
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

function rowsToJsonArrayChunk(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  return (rows || []).map((row) => {
    const obj = {};
    for (const col of cols) obj[col] = row?.[col] ?? null;
    return obj;
  });
}

function padBatch(n) {
  return String(n).padStart(3, '0');
}

function fileMeta(absolutePath, relativePath, rows) {
  const stat = fs.statSync(absolutePath);
  return {
    name: path.basename(absolutePath),
    relativePath,
    absolutePath,
    sizeBytes: stat.size,
    rows,
  };
}

/**
 * Stream-write batches to disk under data/exports/.
 */
async function writeBatchedExport({
  format,
  fileMode,
  baseName,
  relativeDir,
  columns,
  fetchBatch,
}) {
  const kind = String(format || '').toLowerCase() === 'json' ? 'json' : 'csv';
  const mode = String(fileMode || '').toLowerCase() === 'per_batch' ? 'per_batch' : 'single';
  const { relativeDir: relDir, absoluteDir } = resolveExportDir(relativeDir);
  const stem = normalizeBaseName(baseName);

  const files = [];
  let totalRows = 0;
  let batchIndex = 0;
  let columnsFinal = Array.isArray(columns) ? columns : null;
  let singleFd = null;
  let singlePath = null;
  let singleRel = null;
  let jsonFirst = true;

  const openSingle = () => {
    const name = `${stem}.${kind}`;
    singlePath = path.join(absoluteDir, name);
    singleRel = relDir ? `${relDir}/${name}` : name;
    singleFd = fs.openSync(singlePath, 'w', 0o600);
    if (kind === 'json') {
      fs.writeSync(singleFd, '[\n');
    }
  };

  const closeSingle = () => {
    if (singleFd == null) return;
    if (kind === 'json') {
      fs.writeSync(singleFd, '\n]\n');
    }
    fs.closeSync(singleFd);
    singleFd = null;
    files.push(fileMeta(singlePath, singleRel, totalRows));
  };

  try {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const page = await fetchBatch(offset);
      if (!columnsFinal || !columnsFinal.length) {
        columnsFinal = page.columns || [];
      }
      const rows = page.rows || [];
      batchIndex += 1;

      if (batchIndex === 1 && mode === 'single') {
        openSingle();
        if (kind === 'csv' && columnsFinal.length) {
          fs.writeSync(singleFd, rowsToCsv(columnsFinal, [], { header: true }));
        }
      }

      if (!rows.length && batchIndex === 1) {
        // Empty result — still create one empty file for single mode.
        if (mode === 'single') {
          if (kind === 'csv' && columnsFinal.length) {
            // header already written
          } else if (kind === 'json') {
            // array already opened
          }
        } else {
          const name = `${stem}_part${padBatch(1)}.${kind}`;
          const abs = path.join(absoluteDir, name);
          const rel = relDir ? `${relDir}/${name}` : name;
          if (kind === 'csv') {
            fs.writeFileSync(abs, rowsToCsv(columnsFinal, [], { header: true }), {
              encoding: 'utf8',
              mode: 0o600,
            });
          } else {
            fs.writeFileSync(abs, '[]\n', { encoding: 'utf8', mode: 0o600 });
          }
          files.push(fileMeta(abs, rel, 0));
        }
        hasMore = false;
        break;
      }

      if (!rows.length) {
        hasMore = false;
        break;
      }

      totalRows += rows.length;
      if (totalRows > MAX_TOTAL_ROWS) {
        throw httpError(
          `Export exceeded max rows (${MAX_TOTAL_ROWS.toLocaleString()}). Narrow the query or filters.`,
          400
        );
      }

      if (mode === 'per_batch') {
        const name = `${stem}_part${padBatch(batchIndex)}.${kind}`;
        const abs = path.join(absoluteDir, name);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (kind === 'csv') {
          fs.writeFileSync(abs, rowsToCsv(columnsFinal, rows, { header: true }), {
            encoding: 'utf8',
            mode: 0o600,
          });
        } else {
          const chunk = rowsToJsonArrayChunk(columnsFinal, rows);
          fs.writeFileSync(abs, `${JSON.stringify(chunk, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
          });
        }
        files.push(fileMeta(abs, rel, rows.length));
      } else if (kind === 'csv') {
        fs.writeSync(singleFd, rowsToCsv(columnsFinal, rows, { header: false }));
      } else {
        const chunk = rowsToJsonArrayChunk(columnsFinal, rows);
        for (const obj of chunk) {
          const line = `${jsonFirst ? '' : ',\n'}${JSON.stringify(obj, null, 2)}`;
          fs.writeSync(singleFd, line);
          jsonFirst = false;
        }
      }

      hasMore = Boolean(page.hasMore);
      offset += rows.length;
      if (!hasMore) break;
    }

    if (mode === 'single') {
      closeSingle();
    }
  } catch (err) {
    if (singleFd != null) {
      try {
        fs.closeSync(singleFd);
      } catch (_) {
        /* ignore */
      }
      singleFd = null;
      try {
        if (singlePath && fs.existsSync(singlePath)) fs.unlinkSync(singlePath);
      } catch (_) {
        /* ignore */
      }
    }
    throw err;
  }

  // Multi-file or multi-batch single file → disk + popup only (no auto browser download).
  const batchesWritten = Math.max(1, batchIndex);
  const multiFile = files.length > 1;
  const multiBatchSingle = mode === 'single' && batchesWritten > 1;
  const browserDownload = files.length === 1 && !multiFile && !multiBatchSingle;

  return {
    savedToDisk: true,
    exportRoot: EXPORT_ROOT,
    relativeDir: relDir,
    absoluteDir,
    format: kind,
    fileMode: mode,
    baseName: stem,
    batchCount: mode === 'per_batch' ? files.length : batchesWritten,
    totalRows,
    browserDownload,
    files,
  };
}

async function fetchTableBatch(pool, {
  database,
  table,
  batchSize,
  offset,
  sortColumn = null,
  sortDir = 'asc',
  filterColumn = null,
  filterValue = '',
}) {
  const pageLimit = clampBatchSize(batchSize);
  const pageOffset = Math.max(0, Math.round(Number(offset) || 0));
  const params = [];
  let sql = `SELECT * FROM ${pool.escapeId(database)}.${pool.escapeId(table)}`;

  if (filterColumn && String(filterValue).length) {
    sql += ` WHERE ${pool.escapeId(filterColumn)} LIKE ?`;
    params.push(`${filterValue}%`);
  }
  if (sortColumn) {
    sql += ` ORDER BY ${pool.escapeId(sortColumn)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  sql += ` LIMIT ${pageLimit + 1} OFFSET ${pageOffset}`;

  const [result, fields] = await pool.query({ sql, timeout: 120000 }, params);
  const hasMore = result.length > pageLimit;
  const rows = serializeRows(result.slice(0, pageLimit));
  return {
    columns: (fields || []).map((f) => f.name),
    rows,
    hasMore,
  };
}

async function fetchSqlBatch(pool, {
  database = null,
  sql,
  batchSize,
  offset,
}) {
  const { bare, isSelectLike, hasManualLimit } = analyzeSelectSql(sql);
  if (!isSelectLike) {
    throw httpError('Only SELECT-like queries can be exported');
  }

  // Manual LIMIT: one-shot full result (no further batches).
  if (hasManualLimit) {
    if (offset > 0) {
      return { columns: [], rows: [], hasMore: false };
    }
    let connection;
    try {
      connection = await pool.getConnection();
      if (database) {
        await connection.query(`USE ${pool.escapeId(database)}`);
      }
      const [result, fields] = await connection.query({ sql: bare, timeout: 120000 });
      if (!Array.isArray(result)) {
        throw httpError('Query did not return rows');
      }
      return {
        columns: (fields || []).map((f) => f.name),
        rows: serializeRows(result),
        hasMore: false,
      };
    } finally {
      if (connection) connection.release();
    }
  }

  const pageLimit = clampBatchSize(batchSize);
  const pageOffset = Math.max(0, Math.round(Number(offset) || 0));
  const finalSql = `${bare} LIMIT ${pageLimit + 1} OFFSET ${pageOffset}`;

  let connection;
  try {
    connection = await pool.getConnection();
    if (database) {
      await connection.query(`USE ${pool.escapeId(database)}`);
    }
    const [result, fields] = await connection.query({ sql: finalSql, timeout: 120000 });
    if (!Array.isArray(result)) {
      throw httpError('Query did not return rows');
    }
    const hasMore = result.length > pageLimit;
    return {
      columns: (fields || []).map((f) => f.name),
      rows: serializeRows(result.slice(0, pageLimit)),
      hasMore,
    };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Export from an in-memory row set (loaded grid) into data/exports/.
 */
async function exportLoadedRows({
  format,
  fileMode,
  baseName,
  relativeDir,
  columns,
  rows,
  batchSize,
}) {
  const allRows = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columns) ? columns : [];
  const size = clampBatchSize(batchSize);
  let cursor = 0;

  return writeBatchedExport({
    format,
    fileMode,
    baseName,
    relativeDir,
    columns: cols,
    fetchBatch: async () => {
      if (cursor >= allRows.length) {
        return { columns: cols, rows: [], hasMore: false };
      }
      const slice = allRows.slice(cursor, cursor + size);
      cursor += slice.length;
      return {
        columns: cols,
        rows: slice,
        hasMore: cursor < allRows.length,
      };
    },
  });
}

async function exportFromQuery(pool, options) {
  const {
    source,
    database,
    table,
    sql,
    sortColumn,
    sortDir,
    filterColumn,
    filterValue,
    format,
    fileMode,
    baseName,
    relativeDir,
    batchSize,
  } = options;

  const size = clampBatchSize(batchSize);

  if (source === 'table') {
    if (!database || !table) {
      throw httpError('database and table are required');
    }
    return writeBatchedExport({
      format,
      fileMode,
      baseName: baseName || `${database}.${table}`,
      relativeDir,
      columns: null,
      fetchBatch: (offset) =>
        fetchTableBatch(pool, {
          database,
          table,
          batchSize: size,
          offset,
          sortColumn,
          sortDir,
          filterColumn,
          filterValue,
        }),
    });
  }

  if (source === 'sql') {
    if (!sql || !String(sql).trim()) {
      throw httpError('sql is required');
    }
    return writeBatchedExport({
      format,
      fileMode,
      baseName: baseName || 'query-result',
      relativeDir,
      columns: null,
      fetchBatch: (offset) =>
        fetchSqlBatch(pool, {
          database: database || null,
          sql,
          batchSize: size,
          offset,
        }),
    });
  }

  throw httpError('source must be table or sql');
}

function listExportFiles({ limit = 50 } = {}) {
  ensureExportRoot();
  const max = Math.min(200, Math.max(1, Math.round(Number(limit) || 50)));
  const collected = [];

  function walk(dir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && /\.(csv|json)$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(abs);
          collected.push({
            name: entry.name,
            relativePath: rel,
            absolutePath: abs,
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch (_) {
          /* skip */
        }
      }
    }
  }

  walk(EXPORT_ROOT, '');
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    exportRoot: EXPORT_ROOT,
    files: collected.slice(0, max),
  };
}

function getExportInfo() {
  ensureExportRoot();
  return {
    exportRoot: EXPORT_ROOT,
    projectRoot: PROJECT_ROOT,
  };
}

module.exports = {
  EXPORT_ROOT,
  PROJECT_ROOT,
  MIN_BATCH,
  MAX_BATCH,
  DEFAULT_BATCH,
  clampBatchSize,
  normalizeRelativeDir,
  normalizeBaseName,
  resolveSafeFile,
  exportLoadedRows,
  exportFromQuery,
  listExportFiles,
  getExportInfo,
  ensureExportRoot,
};
