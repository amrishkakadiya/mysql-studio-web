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
const activeQueries = require('../lib/activeQueries');

const router = express.Router();

/** Sanitize a client-supplied requestId (used only as a Map key). */
function normalizeRequestId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) return null;
  return trimmed;
}

/**
 * Kill the tracked query when the client aborts (socket close) before we have
 * responded. The `settled` guard avoids killing on a normal completed request.
 */
function attachAbortKill(req, requestId, isSettled) {
  if (!requestId) return;
  req.on('close', () => {
    if (!isSettled()) void activeQueries.cancel(requestId);
  });
}

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
  let settled = false;
  const requestId = normalizeRequestId(req.body?.requestId);
  attachAbortKill(req, requestId, () => settled);
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
        requestId,
        connectionId: id,
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
      // Cancelled runs are user-initiated; don't log them as failures.
      if (pageOffset === 0 && !err.cancelled) {
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
      cancelled: Boolean(err.cancelled),
      ok: false,
    });
  } finally {
    settled = true;
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
  let settled = false;
  const requestId = normalizeRequestId(req.body?.requestId);
  attachAbortKill(req, requestId, () => settled);
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
      requestId,
      connectionId: id,
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
      cancelled: Boolean(err.cancelled),
      ok: false,
    });
  } finally {
    settled = true;
  }
});

/**
 * POST /api/query/cancel
 * Body: { connectionId?, requestId }
 * Explicit Cancel from the UI. Idempotent — a missing/finished requestId is a
 * no-op. The kill runs on the pool captured in the registry, so this works even
 * if the user has navigated away from the originating tab/table.
 */
router.post('/cancel', async (req, res) => {
  const requestId = normalizeRequestId(req.body?.requestId);
  if (!requestId) {
    return res.status(400).json({ error: 'requestId is required', ok: false });
  }
  const killed = await activeQueries.cancel(requestId);
  res.json({ ok: true, killed });
});

module.exports = router;
