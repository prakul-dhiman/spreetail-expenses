const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

// GET /api/groups — list all groups the user is in
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.* FROM groups g
       JOIN group_memberships gm ON g.id = gm.group_id
       WHERE gm.user_id = $1 AND gm.left_at IS NULL`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups — create a group
router.post('/', authMiddleware, async (req, res) => {
  const { name } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const g = await client.query('INSERT INTO groups (name) VALUES ($1) RETURNING *', [name]);
    const group = g.rows[0];
    // Creator is automatically a member
    await client.query(
      'INSERT INTO group_memberships (group_id, user_id, joined_at) VALUES ($1, $2, NOW())',
      [group.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json(group);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/groups/:id/members — list members with join/leave dates
router.get('/:id/members', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, gm.joined_at, gm.left_at
       FROM group_memberships gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/groups/:id/members — add a member
router.post('/:id/members', authMiddleware, async (req, res) => {
  const { user_id, joined_at } = req.body;
  try {
    await pool.query(
      `INSERT INTO group_memberships (group_id, user_id, joined_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET joined_at = $3, left_at = NULL`,
      [req.params.id, user_id, joined_at || new Date()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/groups/:id/members/:userId/leave — mark a member as left
router.patch('/:id/members/:userId/leave', authMiddleware, async (req, res) => {
  const { left_at } = req.body;
  try {
    await pool.query(
      'UPDATE group_memberships SET left_at = $1 WHERE group_id = $2 AND user_id = $3',
      [left_at || new Date(), req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/groups/:id/balances — the key balance calculation
router.get('/:id/balances', authMiddleware, async (req, res) => {
  try {
    const groupId = req.params.id;

    // Total paid by each person
    const paid = await pool.query(
      `SELECT u.id, u.name, COALESCE(SUM(e.amount_inr), 0) as total_paid
       FROM users u
       JOIN group_memberships gm ON gm.user_id = u.id AND gm.group_id = $1
       LEFT JOIN expenses e ON e.paid_by = u.id AND e.group_id = $1
       GROUP BY u.id, u.name`,
      [groupId]
    );

    // Total owed by each person (from expense_splits)
    const owed = await pool.query(
      `SELECT u.id, u.name, COALESCE(SUM(es.amount_owed), 0) as total_owed
       FROM users u
       JOIN group_memberships gm ON gm.user_id = u.id AND gm.group_id = $1
       LEFT JOIN expense_splits es ON es.user_id = u.id
       LEFT JOIN expenses e ON e.id = es.expense_id AND e.group_id = $1
       GROUP BY u.id, u.name`,
      [groupId]
    );

    // Settlements already made
    const settledPaid = await pool.query(
      `SELECT paid_by as id, SUM(amount) as settled FROM settlements WHERE group_id = $1 GROUP BY paid_by`,
      [groupId]
    );
    const settledReceived = await pool.query(
      `SELECT paid_to as id, SUM(amount) as settled FROM settlements WHERE group_id = $1 GROUP BY paid_to`,
      [groupId]
    );

    // Build net balance map: positive = is owed money, negative = owes money
    const balanceMap = {};
    for (const row of paid.rows) {
      balanceMap[row.id] = { id: row.id, name: row.name, net: parseFloat(row.total_paid) };
    }
    for (const row of owed.rows) {
      if (balanceMap[row.id]) balanceMap[row.id].net -= parseFloat(row.total_owed);
    }
    for (const row of settledPaid.rows) {
      if (balanceMap[row.id]) balanceMap[row.id].net -= parseFloat(row.settled);
    }
    for (const row of settledReceived.rows) {
      if (balanceMap[row.id]) balanceMap[row.id].net += parseFloat(row.settled);
    }

    const balances = Object.values(balanceMap);

    // Minimum transactions debt simplification (greedy algorithm)
    // Positives = creditors (are owed), Negatives = debtors (owe)
    const creditors = balances.filter(b => b.net > 0.01).sort((a, b) => b.net - a.net);
    const debtors = balances.filter(b => b.net < -0.01).sort((a, b) => a.net - b.net);

    const transactions = [];
    let i = 0, j = 0;
    while (i < creditors.length && j < debtors.length) {
      const amount = Math.min(creditors[i].net, -debtors[j].net);
      transactions.push({
        from: debtors[j].name,
        to: creditors[i].name,
        amount: Math.round(amount * 100) / 100
      });
      creditors[i].net -= amount;
      debtors[j].net += amount;
      if (Math.abs(creditors[i].net) < 0.01) i++;
      if (Math.abs(debtors[j].net) < 0.01) j++;
    }

    res.json({ balances, transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
