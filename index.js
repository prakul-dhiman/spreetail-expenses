const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const pool = require('./src/db/pool');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS group_memberships (id SERIAL PRIMARY KEY, group_id INT REFERENCES groups(id) ON DELETE CASCADE, user_id INT REFERENCES users(id) ON DELETE CASCADE, joined_at DATE NOT NULL, left_at DATE, UNIQUE(group_id, user_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, group_id INT REFERENCES groups(id) ON DELETE CASCADE, description TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, currency CHAR(3) DEFAULT 'INR', exchange_rate NUMERIC(10,4) DEFAULT 1.0, amount_inr NUMERIC(12,2) NOT NULL, paid_by INT REFERENCES users(id), expense_date DATE NOT NULL, split_type TEXT NOT NULL DEFAULT 'equal', is_refund BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS expense_splits (id SERIAL PRIMARY KEY, expense_id INT REFERENCES expenses(id) ON DELETE CASCADE, user_id INT REFERENCES users(id), amount_owed NUMERIC(12,2) NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settlements (id SERIAL PRIMARY KEY, group_id INT REFERENCES groups(id) ON DELETE CASCADE, paid_by INT REFERENCES users(id), paid_to INT REFERENCES users(id), amount NUMERIC(12,2) NOT NULL, currency CHAR(3) DEFAULT 'INR', settlement_date DATE NOT NULL, note TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS import_log (id SERIAL PRIMARY KEY, row_number INT, raw_data TEXT, anomaly_type TEXT, anomaly_description TEXT, action_taken TEXT, resolved BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`);
  console.log('Database tables ready');
}

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/groups', require('./src/routes/groups'));
app.use('/api/expenses', require('./src/routes/expenses').router);
app.use('/api/import', require('./src/routes/import'));
app.use('/api/settlements', require('./src/routes/settlements'));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err.message || err); process.exit(1); });