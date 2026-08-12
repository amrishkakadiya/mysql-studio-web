const express = require('express');
const {
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
} = require('../lib/scriptManager');

const router = express.Router();

/**
 * GET /api/scripts
 * List all saved SQL files under data/scripts/.
 */
router.get('/', (_req, res) => {
  try {
    res.json({ scripts: listScripts() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to list scripts' });
  }
});

/**
 * GET /api/scripts/:id
 */
router.get('/:id', (req, res) => {
  try {
    const script = getScript(req.params.id);
    if (!script) return res.status(404).json({ error: 'Script not found' });
    res.json({ script });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to load script' });
  }
});

/**
 * POST /api/scripts
 * Body: { name, sql? }
 */
router.post('/', (req, res) => {
  try {
    const { name, sql = '' } = req.body || {};
    const script = createScript({ name, sql_text: sql });
    res.status(201).json({ script });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to create script' });
  }
});

/**
 * PUT /api/scripts/:id
 * Body: { name?, sql? } — rename and/or update contents.
 */
router.put('/:id', (req, res) => {
  try {
    const { name, sql } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (sql !== undefined) patch.sql_text = sql;
    const script = updateScript(req.params.id, patch);
    res.json({ script });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to update script' });
  }
});

/**
 * DELETE /api/scripts/:id
 */
router.delete('/:id', (req, res) => {
  try {
    deleteScript(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to delete script' });
  }
});

module.exports = router;
