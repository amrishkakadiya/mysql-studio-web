const express = require('express');
const {
  listQueryHistory,
  deleteQueryHistory,
  clearQueryHistory,
  getConnection,
} = require('../lib/dbManager');

const router = express.Router();

/**
 * GET /api/history?connectionId=&limit=
 */
router.get('/', (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    if (connectionId != null && connectionId !== '') {
      const id = Number(connectionId);
      if (!Number.isInteger(id) || id < 1 || !getConnection(id)) {
        return res.status(400).json({ error: 'Invalid connection id' });
      }
    }
    const items = listQueryHistory({
      connectionId: connectionId || null,
      limit: req.query.limit,
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load history' });
  }
});

/**
 * DELETE /api/history?connectionId=
 * Clears all history, or only for one connection when connectionId is set.
 * Registered before /:id so bare DELETE / is not captured as an id.
 */
router.delete('/', (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    if (connectionId != null && connectionId !== '') {
      const id = Number(connectionId);
      if (!Number.isInteger(id) || id < 1 || !getConnection(id)) {
        return res.status(400).json({ error: 'Invalid connection id' });
      }
      const removed = clearQueryHistory({ connectionId: id });
      return res.json({ ok: true, removed });
    }
    const removed = clearQueryHistory();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to clear history' });
  }
});

/**
 * DELETE /api/history/:id
 */
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid history id' });
    }
    const ok = deleteQueryHistory(id);
    if (!ok) return res.status(404).json({ error: 'History entry not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete history entry' });
  }
});

module.exports = router;
