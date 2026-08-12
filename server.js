const path = require('path');
const express = require('express');
const { loadEnv } = require('./lib/loadEnv');
const { initDb, closeAllPools, closeSqlite } = require('./lib/dbManager');
const connectionsRouter = require('./routes/connections');

loadEnv();

const APP_NAME = 'MySQL Studio Web';
const LOCAL_HOST = 'mysql-studio-web.local';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';

const app = express();

// Export accepts larger loaded-row payloads; mount before the global 2mb JSON parser.
app.use('/api/export', require('./routes/export'));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: APP_NAME,
    port: PORT,
    host: HOST,
  });
});

app.use('/api/connections', connectionsRouter);
app.use('/api/schema', require('./routes/schema'));
app.use('/api/query', require('./routes/query'));
app.use('/api/scripts', require('./routes/scripts'));
app.use('/api/history', require('./routes/history'));
app.use('/api/settings', require('./routes/settings'));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// data/{config,exports,scripts} — recreate if missing; fix mode + owner.
const { ensureAppDataDirs } = require('./lib/ensureDirs');
try {
  ensureAppDataDirs();
} catch (err) {
  console.error('Failed to create app data directories:', err.message);
  process.exit(1);
}

initDb();

const server = app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} listening on ${HOST}:${PORT}`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → http://${LOCAL_HOST}:${PORT}`);
});

async function shutdown() {
  console.log('Shutting down...');
  server.close();
  await closeAllPools();
  closeSqlite();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
