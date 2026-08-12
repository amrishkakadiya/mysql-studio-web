const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Normalize user SQL and detect whether it is a SELECT-like statement that
 * already includes a manual LIMIT (in which case we never auto-paginate).
 */
function analyzeSelectSql(sql) {
  const original = String(sql || '');
  const trimmed = original.trim();
  if (!trimmed) {
    return {
      bare: original,
      isSelectLike: false,
      hasManualLimit: false,
    };
  }

  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === ';') end -= 1;
  const bare = trimmed.slice(0, end);
  const upper = bare.toUpperCase();

  const isSelectLike =
    upper.startsWith('SELECT') ||
    upper.startsWith('WITH') ||
    upper.startsWith('(SELECT');

  // Rough check: LIMIT already present — treat as user-authored (no auto pages).
  const hasManualLimit = isSelectLike && /\bLIMIT\b/i.test(bare);

  return { bare, isSelectLike, hasManualLimit };
}

/**
 * Append the configured safety limit to SELECT / WITH…SELECT queries.
 * Leaves non-SELECT statements and queries with a manual LIMIT unchanged.
 */
function enforceSelectLimit(sql, limit = DEFAULT_LIMIT) {
  const { bare, isSelectLike, hasManualLimit } = analyzeSelectSql(sql);
  if (!String(sql || '').trim()) {
    return { sql: String(sql || ''), limited: false };
  }
  if (!isSelectLike || hasManualLimit) {
    return { sql: bare, limited: false };
  }
  return {
    sql: `${bare} LIMIT ${Number(limit) || DEFAULT_LIMIT}`,
    limited: true,
  };
}

/**
 * Serialize a cell for JSON (Buffers → hex preview, Dates → local time, BigInt → string).
 */
function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(value) {
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
  ].join('-') + ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function serializeCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) {
    const preview = value.toString('hex').slice(0, 64);
    return value.length > 32 ? `0x${preview}…` : `0x${preview}`;
  }
  if (value instanceof Date) return formatLocalDate(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return value;
}

function serializeRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [key, val] of Object.entries(row)) {
      out[key] = serializeCell(val);
    }
    return out;
  });
}

/**
 * Run SQL on an open mysql2 pool. Optionally set the default schema first.
 *
 * When the statement is SELECT-like and has no manual LIMIT, results are
 * auto-paginated with LIMIT/OFFSET (fetch limit+1 to detect hasMore).
 * A user-authored LIMIT disables pagination entirely.
 */
async function executeQuery(
  pool,
  {
    sql,
    database = null,
    limit = DEFAULT_LIMIT,
    offset = 0,
  } = {}
) {
  const started = process.hrtime.bigint();
  const { bare, isSelectLike, hasManualLimit } = analyzeSelectSql(sql);
  const pageLimit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.round(Number(limit) || DEFAULT_LIMIT))
  );
  const pageOffset = Math.max(0, Math.round(Number(offset) || 0));

  const paginated = Boolean(isSelectLike && !hasManualLimit);
  let finalSql = bare;
  let limited = false;
  if (paginated) {
    limited = true;
    finalSql = `${bare} LIMIT ${pageLimit + 1} OFFSET ${pageOffset}`;
  } else if (!String(sql || '').trim()) {
    finalSql = String(sql || '');
  }

  let connection;
  try {
    connection = await pool.getConnection();
    if (database) {
      await connection.query(`USE ${pool.escapeId(database)}`);
    }

    const [result, fields] = await connection.query(finalSql);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Result set (SELECT / SHOW / etc.)
    if (Array.isArray(result)) {
      const hasMore = paginated && result.length > pageLimit;
      const pageRows = paginated ? result.slice(0, pageLimit) : result;
      const columns = (fields || []).map((f) => f.name);
      const rows = serializeRows(pageRows);
      const displaySql = paginated
        ? `${bare} LIMIT ${pageLimit} OFFSET ${pageOffset}`
        : finalSql;
      return {
        ok: true,
        kind: 'rows',
        columns,
        rows,
        rowCount: rows.length,
        offset: pageOffset,
        limit: pageLimit,
        hasMore: Boolean(hasMore),
        paginated,
        durationMs: Math.round(durationMs * 100) / 100,
        limited,
        sql: displaySql,
      };
    }

    // OK packet (INSERT / UPDATE / DELETE / DDL)
    return {
      ok: true,
      kind: 'ok',
      columns: [],
      rows: [],
      rowCount: result.affectedRows ?? 0,
      affectedRows: result.affectedRows ?? 0,
      insertId: result.insertId ?? null,
      offset: 0,
      limit: pageLimit,
      hasMore: false,
      paginated: false,
      durationMs: Math.round(durationMs * 100) / 100,
      limited: false,
      sql: finalSql,
    };
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Browse a table/view with SELECT * … LIMIT.
 */
async function fetchTableData(
  pool,
  {
    database,
    table,
    limit = DEFAULT_LIMIT,
    offset = 0,
    sortColumn = null,
    sortDir = 'asc',
    filterColumn = null,
    filterValue = '',
  } = {}
) {
  if (!database || !table) {
    throw Object.assign(new Error('database and table are required'), { status: 400 });
  }

  const pageLimit = Math.min(MAX_LIMIT, Math.max(1, Math.round(Number(limit) || DEFAULT_LIMIT)));
  const pageOffset = Math.max(0, Math.round(Number(offset) || 0));
  const params = [];
  let sql = `SELECT * FROM ${pool.escapeId(database)}.${pool.escapeId(table)}`;

  if (filterColumn && String(filterValue).length) {
    // Prefix matching can use a normal column index; leading-wildcard scans cannot.
    sql += ` WHERE ${pool.escapeId(filterColumn)} LIKE ?`;
    params.push(`${filterValue}%`);
  }
  if (sortColumn) {
    sql += ` ORDER BY ${pool.escapeId(sortColumn)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  // Fetch one extra row to determine whether another lazy page exists.
  sql += ` LIMIT ${pageLimit + 1} OFFSET ${pageOffset}`;

  const started = process.hrtime.bigint();
  const [result, fields] = await pool.query({ sql, timeout: 10000 }, params);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const hasMore = result.length > pageLimit;
  const rows = serializeRows(result.slice(0, pageLimit));

  return {
    ok: true,
    kind: 'rows',
    columns: (fields || []).map((field) => field.name),
    rows,
    rowCount: rows.length,
    offset: pageOffset,
    limit: pageLimit,
    hasMore,
    durationMs: Math.round(durationMs * 100) / 100,
    limited: true,
    sql: sql.replace(`LIMIT ${pageLimit + 1}`, `LIMIT ${pageLimit}`),
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  analyzeSelectSql,
  enforceSelectLimit,
  executeQuery,
  fetchTableData,
  serializeRows,
  serializeCell,
};
