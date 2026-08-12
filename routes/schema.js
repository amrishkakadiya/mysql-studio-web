const express = require('express');
const { getPool, hasPool } = require('../lib/dbManager');

const router = express.Router();

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
  return getPool(id);
}

function qid(pool, name) {
  return pool.escapeId(name);
}

router.get('/:connectionId/databases', async (req, res) => {
  try {
    const pool = await requireOpenPool(req.params.connectionId);
    const [rows] = await pool.query('SHOW DATABASES');
    const databases = rows
      .map((row) => Object.values(row)[0])
      .filter(Boolean)
      .sort((a, b) => String(a).localeCompare(String(b)));
    res.json({ databases });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to list databases' });
  }
});

async function listOrEmpty(fn) {
  try {
    return await fn();
  } catch (_) {
    return [];
  }
}

function sortNames(names) {
  return names
    .filter(Boolean)
    .map(String)
    .sort((a, b) => a.localeCompare(b));
}

router.get('/:connectionId/databases/:db/tables', async (req, res) => {
  try {
    const db = req.params.db;
    if (!isSafeIdent(db)) {
      return res.status(400).json({ error: 'Invalid database name' });
    }

    const pool = await requireOpenPool(req.params.connectionId);
    const dbId = qid(pool, db);

    const [tableRows] = await pool.query(
      `SHOW FULL TABLES FROM ${dbId} WHERE Table_type = 'BASE TABLE'`
    );
    const [viewRows] = await pool.query(
      `SHOW FULL TABLES FROM ${dbId} WHERE Table_type = 'VIEW'`
    );

    const nameKey = (row) => Object.keys(row).find((k) => k.startsWith('Tables_in_')) || Object.keys(row)[0];

    const tables = sortNames(tableRows.map((row) => row[nameKey(row)]));
    const views = sortNames(viewRows.map((row) => row[nameKey(row)]));

    const [procedures, triggers, events] = await Promise.all([
      listOrEmpty(async () => {
        const [rows] = await pool.query(
          `SELECT ROUTINE_NAME AS name
           FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
           ORDER BY ROUTINE_NAME`,
          [db]
        );
        return sortNames(rows.map((r) => r.name));
      }),
      listOrEmpty(async () => {
        const [rows] = await pool.query(
          `SELECT TRIGGER_NAME AS name
           FROM information_schema.TRIGGERS
           WHERE TRIGGER_SCHEMA = ?
           ORDER BY TRIGGER_NAME`,
          [db]
        );
        return sortNames(rows.map((r) => r.name));
      }),
      listOrEmpty(async () => {
        const [rows] = await pool.query(
          `SELECT EVENT_NAME AS name
           FROM information_schema.EVENTS
           WHERE EVENT_SCHEMA = ?
           ORDER BY EVENT_NAME`,
          [db]
        );
        return sortNames(rows.map((r) => r.name));
      }),
    ]);

    res.json({ tables, views, procedures, triggers, events });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to list tables' });
  }
});

/**
 * GET /api/schema/:connectionId/databases/:db/completion
 * Bulk table → columns map for SQL autocomplete (sql-hint).
 */
router.get('/:connectionId/databases/:db/completion', async (req, res) => {
  try {
    const db = req.params.db;
    if (!isSafeIdent(db)) {
      return res.status(400).json({ error: 'Invalid database name' });
    }

    const pool = await requireOpenPool(req.params.connectionId);
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db]
    );

    const tables = {};
    for (const row of rows) {
      const tableName = String(row.table_name || row.TABLE_NAME || '');
      const columnName = String(row.column_name || row.COLUMN_NAME || '');
      if (!tableName || !columnName) continue;
      if (!tables[tableName]) tables[tableName] = [];
      tables[tableName].push(columnName);
    }

    // Include empty tables/views that have no columns listed yet.
    const dbId = qid(pool, db);
    const [tableRows] = await pool.query(`SHOW FULL TABLES FROM ${dbId}`);
    const nameKey = (row) =>
      Object.keys(row).find((k) => k.startsWith('Tables_in_')) || Object.keys(row)[0];
    for (const row of tableRows) {
      const name = row[nameKey(row)];
      if (name && !tables[name]) tables[name] = [];
    }

    res.json({
      database: db,
      tables,
      tableCount: Object.keys(tables).length,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Failed to load completion schema',
    });
  }
});

router.get('/:connectionId/databases/:db/tables/:table', async (req, res) => {
  try {
    const { db, table } = req.params;
    if (!isSafeIdent(db) || !isSafeIdent(table)) {
      return res.status(400).json({ error: 'Invalid database or table name' });
    }

    const pool = await requireOpenPool(req.params.connectionId);
    const dbId = qid(pool, db);
    const tableId = qid(pool, table);
    const fullName = `${dbId}.${tableId}`;

    const [columnRows] = await pool.query(`SHOW FULL COLUMNS FROM ${fullName}`);
    const [indexRows] = await pool.query(`SHOW INDEX FROM ${fullName}`);
    const [fkRows] = await pool.query(
      `SELECT
         CONSTRAINT_NAME AS constraint_name,
         COLUMN_NAME AS column_name,
         REFERENCED_TABLE_NAME AS referenced_table,
         REFERENCED_COLUMN_NAME AS referenced_column
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [db, table]
    );
    const [createRows] = await pool.query(`SHOW CREATE TABLE ${fullName}`);
    const createRow = createRows[0] || {};
    const createSql =
      createRow['Create Table'] ||
      createRow['Create View'] ||
      createRow['Create table'] ||
      '';

    const columns = columnRows.map((col) => ({
      name: col.Field,
      type: col.Type,
      nullable: col.Null,
      key: col.Key,
      default: col.Default,
      extra: col.Extra,
      comment: col.Comment || '',
    }));

    const indexMap = new Map();
    for (const row of indexRows) {
      const keyName = row.Key_name;
      if (!indexMap.has(keyName)) {
        indexMap.set(keyName, {
          name: keyName,
          unique: row.Non_unique === 0,
          primary: keyName === 'PRIMARY',
          type: row.Index_type,
          columns: [],
        });
      }
      indexMap.get(keyName).columns.push(row.Column_name);
    }

    const foreignKeys = fkRows.map((row) => ({
      name: row.constraint_name,
      column: row.column_name,
      referenced_table: row.referenced_table,
      referenced_column: row.referenced_column,
    }));

    res.json({
      columns,
      indexes: [...indexMap.values()],
      foreignKeys,
      createSql,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to load table metadata' });
  }
});

/**
 * GET /api/schema/:connectionId/databases/:db/:objectType/:name
 * objectType: procedure | trigger | event — returns SHOW CREATE … SQL.
 * Registered after /tables/:table so table detail is not shadowed.
 */
router.get('/:connectionId/databases/:db/:objectType/:name', async (req, res) => {
  try {
    const { db, objectType, name } = req.params;
    const type = String(objectType || '').toLowerCase();
    if (!isSafeIdent(db) || !isSafeIdent(name)) {
      return res.status(400).json({ error: 'Invalid database or object name' });
    }
    if (!['procedure', 'trigger', 'event'].includes(type)) {
      return res.status(404).json({ error: 'Unknown schema object type' });
    }

    const pool = await requireOpenPool(req.params.connectionId);
    const fullName = `${qid(pool, db)}.${qid(pool, name)}`;

    let createSql = '';
    let meta = {};

    if (type === 'procedure') {
      const [rows] = await pool.query(`SHOW CREATE PROCEDURE ${fullName}`);
      const row = rows[0] || {};
      createSql = row['Create Procedure'] || row['Create procedure'] || '';
      meta = { definer: row.Definer || row.definer || '' };
    } else if (type === 'trigger') {
      const [rows] = await pool.query(`SHOW CREATE TRIGGER ${fullName}`);
      const row = rows[0] || {};
      createSql =
        row['SQL Original Statement'] ||
        row['sql_original_statement'] ||
        row['Create Trigger'] ||
        '';
      meta = {
        definer: row.Definer || row.definer || '',
        sqlMode: row['sql_mode'] || row['SQL Mode'] || '',
      };
    } else if (type === 'event') {
      const [rows] = await pool.query(`SHOW CREATE EVENT ${fullName}`);
      const row = rows[0] || {};
      createSql = row['Create Event'] || row['Create event'] || '';
      meta = {
        definer: row.Definer || row.definer || '',
        timeZone: row.time_zone || row['time_zone'] || '',
      };
    }

    res.json({
      type,
      database: db,
      name,
      createSql,
      ...meta,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || 'Failed to load object DDL',
    });
  }
});

module.exports = router;
