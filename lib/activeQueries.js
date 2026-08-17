/**
 * In-memory registry of in-flight MySQL queries, keyed by a client-supplied
 * requestId. Lets a separate HTTP request (or a dropped socket) cancel a
 * running statement via `KILL QUERY <threadId>` on a fresh pool connection.
 *
 * Entries live only while a query runs — always unregistered in a `finally`.
 * No result sets are ever cached here, so it stays tiny.
 */

/** @type {Map<string, { pool: any, threadId: number, connectionId: number|null }>} */
const active = new Map();

function register(requestId, entry) {
  const key = String(requestId || '');
  if (!key || !entry?.pool || !entry?.threadId) return;
  active.set(key, {
    pool: entry.pool,
    threadId: Number(entry.threadId),
    connectionId: entry.connectionId ?? null,
  });
}

function unregister(requestId) {
  const key = String(requestId || '');
  if (key) active.delete(key);
}

/**
 * Kill the running query for `requestId`, if still tracked. Uses a different
 * connection from the same pool (mysql2 pattern) so KILL QUERY can reach the
 * busy thread. Returns true when a KILL was issued.
 */
async function cancel(requestId) {
  const key = String(requestId || '');
  const entry = active.get(key);
  if (!entry) return false;
  try {
    await entry.pool.query(`KILL QUERY ${entry.threadId}`);
    return true;
  } catch (_) {
    // Thread may have finished already, or lack privilege — treat as no-op.
    return false;
  }
}

function isCancelledError(err) {
  if (!err) return false;
  // ER_QUERY_INTERRUPTED (1317) is raised on the killed connection.
  return (
    err.errno === 1317 ||
    err.code === 'ER_QUERY_INTERRUPTED' ||
    /interrupted/i.test(String(err.message || ''))
  );
}

module.exports = { register, unregister, cancel, isCancelledError };
