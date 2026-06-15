const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

// POST /api/settlements — record a payment
router.post('/', authMiddleware, async (req, res) => {
  const { group_id, paid_by, paid_to, amount, currency, settlement_date, note } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO settlements (group_id, paid_by, paid_to, amount, currency, settlement_date, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [group_id, paid_by, paid_to, amount, currency || 'INR', settlement_date || new Date(), note]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settlements/:groupId
router.get('/:groupId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u1.name as from_name, u2.name as to_name
       FROM settlements s
       JOIN users u1 ON u1.id = s.paid_by
       JOIN users u2 ON u2.id = s.paid_to
       WHERE s.group_id = $1
       ORDER BY s.settlement_date DESC`,
      [req.params.groupId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
