const express = require('express');
const {
  getConnections,
  getConnection,
  getConnectionWithPassword,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  getPool,
  closePool,
  hasPool,
  DEFAULT_KEEP_ALIVE_INTERVAL,
  MIN_KEEP_ALIVE_INTERVAL,
  MAX_KEEP_ALIVE_INTERVAL,
  DEFAULT_ROW_LIMIT,
  MIN_ROW_LIMIT,
  MAX_ROW_LIMIT,
} = require('../lib/dbManager');

const router = express.Router();

function validateProfile(body) {
  const errors = [];
  const nickname = body.nickname != null ? String(body.nickname).trim() : '';
  const host = body.host != null ? String(body.host).trim() : '';
  const user = body.user != null ? String(body.user).trim() : '';

  if (!nickname) errors.push('nickname is required');
  if (!host) errors.push('host is required');
  if (!user) errors.push('user is required');

  if (errors.length) {
    return { ok: false, errors };
  }

  const port =
    body.port === undefined || body.port === '' || body.port === null
      ? 3306
      : Number(body.port);

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return { ok: false, errors: ['port must be a number between 1 and 65535'] };
  }

  let keepAliveInterval =
    body.keep_alive_interval_sec === undefined ||
    body.keep_alive_interval_sec === '' ||
    body.keep_alive_interval_sec === null
      ? DEFAULT_KEEP_ALIVE_INTERVAL
      : Number(body.keep_alive_interval_sec);

  if (Number.isNaN(keepAliveInterval)) {
    return { ok: false, errors: ['keep_alive_interval_sec must be a number'] };
  }

  keepAliveInterval = Math.round(keepAliveInterval);
  if (
    keepAliveInterval < MIN_KEEP_ALIVE_INTERVAL ||
    keepAliveInterval > MAX_KEEP_ALIVE_INTERVAL
  ) {
    return {
      ok: false,
      errors: [
        `keep_alive_interval_sec must be between ${MIN_KEEP_ALIVE_INTERVAL} and ${MAX_KEEP_ALIVE_INTERVAL}`,
      ],
    };
  }

  const rowLimit =
    body.row_limit === undefined || body.row_limit === '' || body.row_limit === null
      ? DEFAULT_ROW_LIMIT
      : Math.round(Number(body.row_limit));
  if (
    !Number.isFinite(rowLimit) ||
    rowLimit < MIN_ROW_LIMIT ||
    rowLimit > MAX_ROW_LIMIT
  ) {
    return {
      ok: false,
      errors: [`row_limit must be between ${MIN_ROW_LIMIT} and ${MAX_ROW_LIMIT}`],
    };
  }

  return {
    ok: true,
    data: {
      nickname,
      host,
      port,
      user,
      password: body.password == null ? '' : String(body.password),
      database_name:
        body.database_name == null || String(body.database_name).trim() === ''
          ? null
          : String(body.database_name).trim(),
      theme_color:
        body.theme_color && String(body.theme_color).trim()
          ? String(body.theme_color).trim()
          : '#3B82F6',
      keep_alive:
        body.keep_alive === true ||
        body.keep_alive === 1 ||
        body.keep_alive === '1' ||
        body.keep_alive === 'true',
      keep_alive_interval_sec: keepAliveInterval,
      row_limit: rowLimit,
    },
  };
}

router.get('/', (_req, res) => {
  res.json({ connections: getConnections() });
});

router.post('/test', async (req, res) => {
  try {
    const body = req.body || {};
    let config;

    if (body.id) {
      const existing = getConnectionWithPassword(Number(body.id));
      if (!existing) {
        return res.status(404).json({ error: 'Connection not found' });
      }
      config = {
        host: body.host != null ? body.host : existing.host,
        port: body.port != null ? body.port : existing.port,
        user: body.user != null ? body.user : existing.user,
        password:
          body.password === undefined || body.password === null || body.password === ''
            ? existing.password
            : body.password,
        database_name:
          body.database_name !== undefined
            ? body.database_name || null
            : existing.database_name,
      };
    } else {
      const result = validateProfile(body);
      if (!result.ok) {
        return res.status(400).json({ error: result.errors.join(', ') });
      }
      config = result.data;
    }

    const outcome = await testConnection(config);
    res.json(outcome);
  } catch (err) {
    res.status(400).json({
      ok: false,
      message: err.message || 'Connection failed',
    });
  }
});

router.post('/:id/connect', async (req, res) => {
  const id = Number(req.params.id);
  const connection = getConnection(id);
  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  try {
    await getPool(id);
    res.json({ ok: true, connection });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err.message || 'Failed to connect',
    });
  }
});

router.post('/:id/disconnect', async (req, res) => {
  const id = Number(req.params.id);
  const connection = getConnection(id);
  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  await closePool(id);
  res.json({ ok: true, connected: hasPool(id) });
});

router.get('/:id', (req, res) => {
  const connection = getConnection(Number(req.params.id));
  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }
  res.json({ connection, connected: hasPool(Number(req.params.id)) });
});

router.post('/', (req, res) => {
  const result = validateProfile(req.body || {});
  if (!result.ok) {
    return res.status(400).json({ error: result.errors.join(', ') });
  }

  const connection = createConnection(result.data);
  res.status(201).json({ connection });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getConnection(id)) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const result = validateProfile(req.body || {});
  if (!result.ok) {
    return res.status(400).json({ error: result.errors.join(', ') });
  }

  const connection = updateConnection(id, result.data);
  res.json({ connection });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const deleted = deleteConnection(id);
  if (!deleted) {
    return res.status(404).json({ error: 'Connection not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
