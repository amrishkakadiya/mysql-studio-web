const express = require('express');
const {
  getPool,
  hasPool,
  getConnection,
  addQueryHistory,
} = require('../lib/dbManager');
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  executeQuery,
  fetchTableData,
} = require('../lib/queryExecutor');

const router = express.Router();

function recordHistory(entry) {
  try {
    addQueryHistory(entry);
  } catch (_) {
    // History must never break query execution.
  }
}

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
 * POST /api/query/execute
 * Body: { connectionId, database?, sql, offset?, limit? }
 * Without a manual LIMIT on SELECT, results paginate via offset/limit.
 */
router.post('/execute', async (req, res) => {
  try {
    const {
      connectionId,
      database = null,
      sql,
      offset = 0,
      limit = null,
    } = req.body || {};
    if (!sql || typeof sql !== 'string' || !sql.trim()) {
      return res.status(400).json({ error: 'sql is required' });
    }
    if (database != null && database !== '' && !isSafeIdent(database)) {
      return res.status(400).json({ error: 'Invalid database name' });
    }

    const { id, pool } = await requireOpenPool(connectionId);
    const profile = getConnection(id);
    const configuredLimit = profile?.row_limit || DEFAULT_LIMIT;
    const requestedLimit = Number(limit);
    const pageLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_LIMIT, Math.round(requestedLimit))
        : configuredLimit;
    const pageOffset = Math.max(0, Math.round(Number(offset) || 0));

    try {
      const result = await executeQuery(pool, {
        sql,
        database: database || null,
        limit: pageLimit,
        offset: pageOffset,
      });
      // Only the first page is written to history (avoid scroll spam).
      if (pageOffset === 0) {
        recordHistory({
          connectionId: id,
          sqlText: result.sql || sql,
          durationMs: result.durationMs,
          status: 'ok',
        });
      }
      res.json({ ...result, configuredLimit });
    } catch (err) {
      if (pageOffset === 0) {
        recordHistory({
          connectionId: id,
          sqlText: sql,
          durationMs: null,
          status: 'error',
          errorMessage: err.message || 'Query failed',
        });
      }
      throw err;
    }
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Query failed',
      ok: false,
    });
  }
});

/**
 * POST /api/query/table
 * Body: { connectionId, database, table, offset?, limit?, sortColumn?, sortDir?,
 *         filterColumn?, filterValue? }
 * `limit` is a per-request page size override; it never changes the stored
 * connection profile default.
 */
router.post('/table', async (req, res) => {
  try {
    const {
      connectionId,
      database,
      table,
      offset = 0,
      limit = null,
      sortColumn = null,
      sortDir = 'asc',
      filterColumn = null,
      filterValue = '',
    } = req.body || {};
    if (!isSafeIdent(database) || !isSafeIdent(table)) {
      return res.status(400).json({ error: 'Invalid database or table name' });
    }
    if (sortColumn && !isSafeIdent(sortColumn)) {
      return res.status(400).json({ error: 'Invalid sort column' });
    }
    if (filterColumn && !isSafeIdent(filterColumn)) {
      return res.status(400).json({ error: 'Invalid filter column' });
    }

    const { id, pool } = await requireOpenPool(connectionId);
    const profile = getConnection(id);
    const configuredLimit = profile?.row_limit || DEFAULT_LIMIT;
    const requestedLimit = Number(limit);
    const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(MAX_LIMIT, Math.round(requestedLimit))
      : configuredLimit;

    const result = await fetchTableData(pool, {
      database,
      table,
      limit: pageLimit,
      offset,
      sortColumn,
      sortDir,
      filterColumn,
      filterValue: String(filterValue || '').slice(0, 500),
    });
    res.json({
      ...result,
      database,
      table,
      configuredLimit,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Failed to load table data',
      ok: false,
    });
  }
});

module.exports = router;
