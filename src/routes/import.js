const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const { importCSV } = require('../importer');

const upload = multer({ dest: 'uploads/' });

// POST /api/import/:groupId — upload and import CSV
router.post('/:groupId', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const report = await importCSV(req.file.path, parseInt(req.params.groupId));
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/log/:groupId — get all import log entries
router.get('/log/:groupId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM import_log ORDER BY row_number ASC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
