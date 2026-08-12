const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { getPool, hasPool } = require('../lib/dbManager');
const {
  DEFAULT_BATCH,
  exportFromQuery,
  exportLoadedRows,
  listExportFiles,
  getExportInfo,
  resolveSafeFile,
  ensureExportRoot,
} = require('../lib/exportManager');

const router = express.Router();

// Loaded-row payloads can be large; keep this route generous.
router.use(express.json({ limit: '32mb' }));

function isSafeIdent(name) {
  return typeof name === 'string' && name.length > 0 && !/[`\0]/.test(name);
}

async function requireOpenPool(connectionId) {
  const id = Number(connectionId);
  if (!Number.isInteger(id) || id < 1) {
    const err = new Error('Invalid connection id');
    err.status = 400;
    throw err;
  }
  if (!hasPool(id)) {
    const err = new Error('Connection is not open. Connect first.');
    err.status = 400;
    throw err;
  }
  return { id, pool: await getPool(id) };
}

/**
 * GET /api/export/info
 */
router.get('/info', (_req, res) => {
  try {
    ensureExportRoot();
    res.json(getExportInfo());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read export info' });
  }
});

/**
 * GET /api/export/files?limit=
 */
router.get('/files', (req, res) => {
  try {
    res.json(listExportFiles({ limit: req.query.limit }));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list export files' });
  }
});

/**
 * GET /api/export/download?path=relative/file.csv
 */
router.get('/download', (req, res) => {
  try {
    const { absolutePath, relativePath } = resolveSafeFile(req.query.path);
    const ext = path.extname(absolutePath).toLowerCase();
    const mime =
      ext === '.json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8';
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${path.basename(absolutePath).replace(/"/g, '')}"`
    );
    res.setHeader('X-Export-Relative-Path', relativePath);
    fs.createReadStream(absolutePath).pipe(res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Download failed' });
  }
});

/**
 * POST /api/export/run
 * Body:
 * {
 *   connectionId,
 *   scope: 'all' | 'loaded',
 *   source: 'table' | 'sql',
 *   database?, table?, sql?,
 *   sortColumn?, sortDir?, filterColumn?, filterValue?,
 *   columns?, rows?,           // required when scope=loaded
 *   format: 'csv' | 'json',
 *   fileMode: 'single' | 'per_batch',
 *   batchSize?,
 *   baseName?,
 *   relativePath?             // folder under data/exports/
 * }
 */
router.post('/run', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      connectionId,
      scope = 'all',
      source,
      database = null,
      table = null,
      sql = null,
      sortColumn = null,
      sortDir = 'asc',
      filterColumn = null,
      filterValue = '',
      columns = null,
      rows = null,
      format = 'csv',
      fileMode = 'single',
      batchSize = DEFAULT_BATCH,
      baseName = '',
      relativePath = '',
    } = body;

    if (!['csv', 'json'].includes(String(format).toLowerCase())) {
      return res.status(400).json({ error: 'format must be csv or json' });
    }
    if (!['single', 'per_batch'].includes(String(fileMode).toLowerCase())) {
      return res.status(400).json({ error: 'fileMode must be single or per_batch' });
    }
    if (!['all', 'loaded'].includes(String(scope).toLowerCase())) {
      return res.status(400).json({ error: 'scope must be all or loaded' });
    }
    if (database != null && database !== '' && !isSafeIdent(database)) {
      return res.status(400).json({ error: 'Invalid database name' });
    }
    if (table != null && table !== '' && !isSafeIdent(table)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }
    if (sortColumn != null && sortColumn !== '' && !isSafeIdent(sortColumn)) {
      return res.status(400).json({ error: 'Invalid sort column' });
    }
    if (filterColumn != null && filterColumn !== '' && !isSafeIdent(filterColumn)) {
      return res.status(400).json({ error: 'Invalid filter column' });
    }

    let result;
    if (String(scope).toLowerCase() === 'loaded') {
      if (!Array.isArray(columns) || !columns.length) {
        return res.status(400).json({ error: 'columns are required for loaded export' });
      }
      if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'rows are required for loaded export' });
      }
      result = await exportLoadedRows({
        format,
        fileMode,
        baseName:
          baseName ||
          (source === 'table' && database && table
            ? `${database}.${table}`
            : 'query-result'),
        relativeDir: relativePath,
        columns,
        rows,
        batchSize,
      });
    } else {
      const { pool } = await requireOpenPool(connectionId);
      result = await exportFromQuery(pool, {
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
        relativeDir: relativePath,
        batchSize,
      });
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || 'Export failed',
    });
  }
});

module.exports = router;
