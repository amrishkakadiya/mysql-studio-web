const express = require('express');
const { getAppSettings, updateAppSettings } = require('../lib/dbManager');

const router = express.Router();

/**
 * GET /api/settings
 */
router.get('/', (_req, res) => {
  try {
    res.json({ settings: getAppSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load settings' });
  }
});

/**
 * PUT /api/settings
 * Body: partial { ui_font_family, ui_font_size, editor_font_family, editor_font_size }
 */
router.put('/', (req, res) => {
  try {
    const settings = updateAppSettings(req.body || {});
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save settings' });
  }
});

module.exports = router;
