const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

// Helper: calculate splits and insert them
async function insertExpenseWithSplits(client, expenseId, splitType, members, totalINR, splitDetails) {
  const splits = calculateSplits(splitType, members, totalINR, splitDetails);
  for (const split of splits) {
    await client.query(
      'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
      [expenseId, split.userId, split.amount]
    );
  }
}

function calculateSplits(splitType, members, totalINR, splitDetails) {
  // members = [{ id, name }], splitDetails = raw string from CSV or form
  const n = members.length;
  const splits = [];

  if (splitType === 'equal') {
    const each = Math.round((totalINR / n) * 100) / 100;
    // Give rounding remainder to first person
    const remainder = Math.round((totalINR - each * n) * 100) / 100;
    members.forEach((m, idx) => {
      splits.push({ userId: m.id, amount: idx === 0 ? each + remainder : each });
    });

  } else if (splitType === 'unequal') {
    // splitDetails like "Rohan 700; Priya 400; Meera 400"
    const parts = splitDetails.split(';').map(s => s.trim());
    for (const part of parts) {
      const match = part.match(/^(\w+)\s+([\d.]+)$/);
      if (match) {
        const member = members.find(m => m.name.toLowerCase() === match[1].toLowerCase());
        if (member) splits.push({ userId: member.id, amount: parseFloat(match[2]) });
      }
    }

  } else if (splitType === 'percentage') {
    // splitDetails like "Aisha 30%; Rohan 30%; Priya 30%; Meera 20%"
    const parts = splitDetails.split(';').map(s => s.trim());
    for (const part of parts) {
      const match = part.match(/^(\w+)\s+([\d.]+)%$/);
      if (match) {
        const member = members.find(m => m.name.toLowerCase() === match[1].toLowerCase());
        if (member) {
          splits.push({ userId: member.id, amount: Math.round((totalINR * parseFloat(match[2]) / 100) * 100) / 100 });
        }
      }
    }

  } else if (splitType === 'share') {
    // splitDetails like "Aisha 1; Rohan 2; Priya 1; Dev 2"
    const parts = splitDetails.split(';').map(s => s.trim());
    let totalShares = 0;
    const parsed = [];
    for (const part of parts) {
      const match = part.match(/^(\w+)\s+([\d.]+)$/);
      if (match) {
        const member = members.find(m => m.name.toLowerCase() === match[1].toLowerCase());
        if (member) {
          const shares = parseFloat(match[2]);
          totalShares += shares;
          parsed.push({ userId: member.id, shares });
        }
      }
    }
    for (const p of parsed) {
      splits.push({ userId: p.userId, amount: Math.round((totalINR * p.shares / totalShares) * 100) / 100 });
    }
  }

  return splits;
}

// GET /api/expenses/:groupId — list expenses for a group
router.get('/:groupId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, u.name as paid_by_name,
        json_agg(json_build_object('user_id', es.user_id, 'name', u2.name, 'amount', es.amount_owed)) as splits
       FROM expenses e
       JOIN users u ON u.id = e.paid_by
       LEFT JOIN expense_splits es ON es.expense_id = e.id
       LEFT JOIN users u2 ON u2.id = es.user_id
       WHERE e.group_id = $1
       GROUP BY e.id, u.name
       ORDER BY e.expense_date DESC`,
      [req.params.groupId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses — create an expense
router.post('/', authMiddleware, async (req, res) => {
  const { group_id, description, amount, currency, paid_by, expense_date, split_type, member_ids, split_details } = req.body;
  const USD_TO_INR = parseFloat(process.env.USD_TO_INR) || 83.5;
  const exchange_rate = currency === 'USD' ? USD_TO_INR : 1.0;
  const amount_inr = amount * exchange_rate;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exp = await client.query(
      `INSERT INTO expenses (group_id, description, amount, currency, exchange_rate, amount_inr, paid_by, expense_date, split_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [group_id, description, amount, currency || 'INR', exchange_rate, amount_inr, paid_by, expense_date, split_type]
    );
    const expense = exp.rows[0];

    // Get member names for split calculation
    const memberRes = await client.query('SELECT id, name FROM users WHERE id = ANY($1)', [member_ids]);
    await insertExpenseWithSplits(client, expense.id, split_type, memberRes.rows, amount_inr, split_details || '');

    await client.query('COMMIT');
    res.json(expense);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, calculateSplits, insertExpenseWithSplits };
