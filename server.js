// ===================================
// FINANCE TRACKER BACKEND - server.js
// Multi-user Personal Finance API
// ===================================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE CONNECTION =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    // Fallback to individual settings if DATABASE_URL not set
    ...(process.env.DATABASE_URL ? {} : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
    })
});

// Test database connection on startup
pool.query('SELECT NOW()')
    .then(() => console.log('✅ Database connected successfully'))
    .catch(err => console.error('❌ Database connection failed:', err.message));

// ===== MIDDLEWARE =====
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests, please try again later.' } });
app.use('/api/', limiter);

// File upload config (for CSV imports)
const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) { cb(null, true); }
    else { cb(new Error('Only CSV files are allowed'), false); }
}});

// ===== AUTH MIDDLEWARE =====
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
}

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
    res.json({ status: 'Finance Tracker API is running', version: '2.0.0' });
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'healthy', database: 'connected', timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
    }
});

// =============================================
// AUTH ROUTES
// =============================================

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name, phone } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name are required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        // Check if user exists
        const existing = await pool.query('SELECT user_id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

        // Create user
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            'INSERT INTO users (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING user_id, email, name',
            [email.toLowerCase(), passwordHash, name, phone || null]
        );

        // Create default chart of accounts for the new user
        await createDefaultAccounts(result.rows[0].user_id);

        // Generate token
        const token = jwt.sign({ userId: result.rows[0].user_id, email: result.rows[0].email }, JWT_SECRET, { expiresIn: '30d' });

        res.status(201).json({ message: 'Registration successful', user: result.rows[0], token });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

        const result = await pool.query('SELECT user_id, email, name, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });

        // Update last login
        await pool.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]);

        const token = jwt.sign({ userId: user.user_id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

        res.json({ message: 'Login successful', user: { user_id: user.user_id, email: user.email, name: user.name }, token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT user_id, email, name, phone, created_at, last_login FROM users WHERE user_id = $1',
            [req.user.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// =============================================
// ACCOUNTS (Chart of Accounts) ROUTES
// =============================================

// Get all accounts for user
app.get('/api/accounts', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, COALESCE(
                (SELECT SUM(CASE WHEN t.debit_account_id = a.account_id THEN t.amount ELSE 0 END) -
                        SUM(CASE WHEN t.credit_account_id = a.account_id THEN t.amount ELSE 0 END)
                 FROM transactions t WHERE t.debit_account_id = a.account_id OR t.credit_account_id = a.account_id), 0
            ) as calculated_balance
            FROM accounts a WHERE a.user_id = $1 ORDER BY a.account_type, a.account_name`,
            [req.user.userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Fetch accounts error:', error);
        res.status(500).json({ error: 'Failed to fetch accounts' });
    }
});

// Create account
app.post('/api/accounts', authenticateToken, async (req, res) => {
    try {
        const { account_name, account_type, sub_type, description, opening_balance, currency } = req.body;
        if (!account_name || !account_type) return res.status(400).json({ error: 'Account name and type are required' });

        const validTypes = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
        if (!validTypes.includes(account_type)) return res.status(400).json({ error: `Account type must be one of: ${validTypes.join(', ')}` });

        const result = await pool.query(
            `INSERT INTO accounts (user_id, account_name, account_type, sub_type, description, current_balance, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [req.user.userId, account_name, account_type, sub_type || null, description || null, opening_balance || 0, currency || 'INR']
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Create account error:', error);
        res.status(500).json({ error: 'Failed to create account' });
    }
});

// Update account
app.put('/api/accounts/:id', authenticateToken, async (req, res) => {
    try {
        const { account_name, sub_type, description } = req.body;
        const result = await pool.query(
            `UPDATE accounts SET account_name = COALESCE($1, account_name), sub_type = COALESCE($2, sub_type),
             description = COALESCE($3, description), updated_at = NOW()
             WHERE account_id = $4 AND user_id = $5 RETURNING *`,
            [account_name, sub_type, description, req.params.id, req.user.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update account' });
    }
});

// Delete account (only if no transactions)
app.delete('/api/accounts/:id', authenticateToken, async (req, res) => {
    try {
        const txCheck = await pool.query(
            'SELECT COUNT(*) FROM transactions WHERE (debit_account_id = $1 OR credit_account_id = $1) AND user_id = $2',
            [req.params.id, req.user.userId]
        );
        if (parseInt(txCheck.rows[0].count) > 0) return res.status(400).json({ error: 'Cannot delete account with transactions. Move or delete transactions first.' });

        const result = await pool.query('DELETE FROM accounts WHERE account_id = $1 AND user_id = $2 RETURNING *', [req.params.id, req.user.userId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
        res.json({ message: 'Account deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

// =============================================
// TRANSACTIONS ROUTES (Double-Entry)
// =============================================

// Get transactions (with filters and pagination)
app.get('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 50, account_id, start_date, end_date, category, search, sort_by = 'date', sort_order = 'DESC' } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE t.user_id = $1';
        let params = [req.user.userId];
        let paramIndex = 2;

        if (account_id) { whereClause += ` AND (t.debit_account_id = $${paramIndex} OR t.credit_account_id = $${paramIndex})`; params.push(account_id); paramIndex++; }
        if (start_date) { whereClause += ` AND t.date >= $${paramIndex}`; params.push(start_date); paramIndex++; }
        if (end_date) { whereClause += ` AND t.date <= $${paramIndex}`; params.push(end_date); paramIndex++; }
        if (category) { whereClause += ` AND t.category = $${paramIndex}`; params.push(category); paramIndex++; }
        if (search) { whereClause += ` AND (t.description ILIKE $${paramIndex} OR t.narration ILIKE $${paramIndex})`; params.push(`%${search}%`); paramIndex++; }

        // Get total count
        const countResult = await pool.query(`SELECT COUNT(*) FROM transactions t ${whereClause}`, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Validate sort
        const validSorts = ['date', 'amount', 'category', 'created_at'];
        const validOrders = ['ASC', 'DESC'];
        const sortField = validSorts.includes(sort_by) ? sort_by : 'date';
        const order = validOrders.includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

        // Get transactions with account names
        const result = await pool.query(
            `SELECT t.*, da.account_name as debit_account_name, da.account_type as debit_account_type,
                    ca.account_name as credit_account_name, ca.account_type as credit_account_type
             FROM transactions t
             LEFT JOIN accounts da ON t.debit_account_id = da.account_id
             LEFT JOIN accounts ca ON t.credit_account_id = ca.account_id
             ${whereClause}
             ORDER BY t.${sortField} ${order}, t.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        res.json({
            transactions: result.rows,
            pagination: { page: parseInt(page), limit: parseInt(limit), total: totalCount, total_pages: Math.ceil(totalCount / limit) }
        });
    } catch (error) {
        console.error('Fetch transactions error:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// Create transaction (double-entry)
app.post('/api/transactions', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { date, amount, description, narration, debit_account_id, credit_account_id, category, tax_category, reference_number } = req.body;

        if (!date || !amount || !debit_account_id || !credit_account_id) {
            return res.status(400).json({ error: 'Date, amount, debit account, and credit account are required' });
        }
        if (debit_account_id === credit_account_id) {
            return res.status(400).json({ error: 'Debit and credit accounts must be different' });
        }

        // Verify accounts belong to user
        const accountCheck = await client.query(
            'SELECT account_id FROM accounts WHERE account_id IN ($1, $2) AND user_id = $3',
            [debit_account_id, credit_account_id, req.user.userId]
        );
        if (accountCheck.rows.length < 2) return res.status(400).json({ error: 'One or both accounts not found' });

        const result = await client.query(
            `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, tax_category, reference_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [req.user.userId, date, amount, description || '', narration || '', debit_account_id, credit_account_id, category || 'Uncategorized', tax_category || null, reference_number || null]
        );

        // Update account balances
        await updateAccountBalance(client, debit_account_id);
        await updateAccountBalance(client, credit_account_id);

        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create transaction error:', error);
        res.status(500).json({ error: 'Failed to create transaction' });
    } finally {
        client.release();
    }
});

// Update transaction
app.put('/api/transactions/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { date, amount, description, narration, debit_account_id, credit_account_id, category, tax_category } = req.body;

        // Get old transaction to update old account balances
        const oldTx = await client.query('SELECT * FROM transactions WHERE transaction_id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
        if (oldTx.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transaction not found' }); }

        const result = await client.query(
            `UPDATE transactions SET date = COALESCE($1, date), amount = COALESCE($2, amount), description = COALESCE($3, description),
             narration = COALESCE($4, narration), debit_account_id = COALESCE($5, debit_account_id),
             credit_account_id = COALESCE($6, credit_account_id), category = COALESCE($7, category),
             tax_category = COALESCE($8, tax_category), updated_at = NOW()
             WHERE transaction_id = $9 AND user_id = $10 RETURNING *`,
            [date, amount, description, narration, debit_account_id, credit_account_id, category, tax_category, req.params.id, req.user.userId]
        );

        // Update balances for all affected accounts
        const accountIds = new Set([oldTx.rows[0].debit_account_id, oldTx.rows[0].credit_account_id, result.rows[0].debit_account_id, result.rows[0].credit_account_id]);
        for (const accId of accountIds) { await updateAccountBalance(client, accId); }

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to update transaction' });
    } finally {
        client.release();
    }
});

// Delete transaction
app.delete('/api/transactions/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tx = await client.query('DELETE FROM transactions WHERE transaction_id = $1 AND user_id = $2 RETURNING *', [req.params.id, req.user.userId]);
        if (tx.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Transaction not found' }); }

        await updateAccountBalance(client, tx.rows[0].debit_account_id);
        await updateAccountBalance(client, tx.rows[0].credit_account_id);

        await client.query('COMMIT');
        res.json({ message: 'Transaction deleted successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to delete transaction' });
    } finally {
        client.release();
    }
});

// =============================================
// CSV IMPORT ROUTE
// =============================================
app.post('/api/transactions/import-csv', authenticateToken, upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) return res.status(400).json({ error: 'CSV file is required' });

        const csvContent = fs.readFileSync(req.file.path, 'utf-8');
        const parsed = Papa.parse(csvContent, { header: true, skipEmptyLines: true, dynamicTyping: true });

        if (parsed.errors.length > 0) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'CSV parsing errors', details: parsed.errors.slice(0, 5) });
        }

        await client.query('BEGIN');
        let imported = 0, skipped = 0, errors = [];

        // Get user's accounts for mapping
        const accounts = await client.query('SELECT account_id, account_name, account_type FROM accounts WHERE user_id = $1', [req.user.userId]);
        const accountMap = {};
        accounts.rows.forEach(a => { accountMap[a.account_name.toLowerCase()] = a.account_id; });

        for (const row of parsed.data) {
            try {
                const date = row.Date || row.date || row.DATE;
                const amount = parseFloat(row.Amount || row.amount || row.AMOUNT || 0);
                const description = row.Description || row.description || row.Narration || row.narration || '';
                const debitName = (row.Debit || row.debit_account || row['Debit Account'] || '').toLowerCase();
                const creditName = (row.Credit || row.credit_account || row['Credit Account'] || '').toLowerCase();
                const category = row.Category || row.category || 'Uncategorized';

                if (!date || !amount || !debitName || !creditName) { skipped++; continue; }

                const debitId = accountMap[debitName];
                const creditId = accountMap[creditName];

                if (!debitId || !creditId) {
                    errors.push(`Row: Missing account "${debitName}" or "${creditName}"`);
                    skipped++;
                    continue;
                }

                await client.query(
                    `INSERT INTO transactions (user_id, date, amount, description, debit_account_id, credit_account_id, category)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [req.user.userId, date, Math.abs(amount), description, debitId, creditId, category]
                );
                imported++;
            } catch (err) {
                errors.push(`Row error: ${err.message}`);
                skipped++;
            }
        }

        // Update all account balances
        for (const acc of accounts.rows) { await updateAccountBalance(client, acc.account_id); }

        await client.query('COMMIT');
        fs.unlinkSync(req.file.path); // Clean up uploaded file

        res.json({ message: 'CSV import complete', imported, skipped, total: parsed.data.length, errors: errors.slice(0, 10) });
    } catch (error) {
        await client.query('ROLLBACK');
        if (req.file) fs.unlinkSync(req.file.path);
        console.error('CSV import error:', error);
        res.status(500).json({ error: 'CSV import failed' });
    } finally {
        client.release();
    }
});

// =============================================
// ANALYTICS & DASHBOARD ROUTES
// =============================================

// Dashboard summary
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Account balances by type
        const balances = await pool.query(
            `SELECT account_type, SUM(current_balance) as total
             FROM accounts WHERE user_id = $1 GROUP BY account_type`,
            [userId]
        );

        // Monthly income & expenses (last 12 months)
        const monthly = await pool.query(
            `SELECT TO_CHAR(t.date, 'YYYY-MM') as month,
                    SUM(CASE WHEN ca.account_type = 'Income' THEN t.amount ELSE 0 END) as income,
                    SUM(CASE WHEN da.account_type = 'Expense' THEN t.amount ELSE 0 END) as expenses
             FROM transactions t
             LEFT JOIN accounts da ON t.debit_account_id = da.account_id
             LEFT JOIN accounts ca ON t.credit_account_id = ca.account_id
             WHERE t.user_id = $1 AND t.date >= NOW() - INTERVAL '12 months'
             GROUP BY TO_CHAR(t.date, 'YYYY-MM')
             ORDER BY month DESC`,
            [userId]
        );

        // Top spending categories (current month)
        const topCategories = await pool.query(
            `SELECT t.category, SUM(t.amount) as total, COUNT(*) as count
             FROM transactions t
             JOIN accounts da ON t.debit_account_id = da.account_id
             WHERE t.user_id = $1 AND da.account_type = 'Expense'
               AND TO_CHAR(t.date, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')
             GROUP BY t.category ORDER BY total DESC LIMIT 10`,
            [userId]
        );

        // Recent transactions
        const recent = await pool.query(
            `SELECT t.*, da.account_name as debit_account_name, ca.account_name as credit_account_name
             FROM transactions t
             LEFT JOIN accounts da ON t.debit_account_id = da.account_id
             LEFT JOIN accounts ca ON t.credit_account_id = ca.account_id
             WHERE t.user_id = $1 ORDER BY t.date DESC, t.created_at DESC LIMIT 10`,
            [userId]
        );

        // Transaction count
        const txCount = await pool.query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]);

        const balanceMap = {};
        balances.rows.forEach(b => { balanceMap[b.account_type] = parseFloat(b.total); });

        res.json({
            net_worth: (balanceMap.Asset || 0) - (balanceMap.Liability || 0),
            total_assets: balanceMap.Asset || 0,
            total_liabilities: balanceMap.Liability || 0,
            total_equity: balanceMap.Equity || 0,
            total_income: balanceMap.Income || 0,
            total_expenses: balanceMap.Expense || 0,
            monthly_summary: monthly.rows,
            top_categories: topCategories.rows,
            recent_transactions: recent.rows,
            transaction_count: parseInt(txCount.rows[0].count)
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard' });
    }
});

// FIRE Calculator
app.get('/api/analytics/fire', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { annual_return = 0.12, withdrawal_rate = 0.04, target_age = 45, current_age = 30 } = req.query;

        // Get average monthly income and expenses (last 6 months)
        const avgMonthly = await pool.query(
            `SELECT
                AVG(monthly_income) as avg_income,
                AVG(monthly_expense) as avg_expense
             FROM (
                SELECT TO_CHAR(t.date, 'YYYY-MM') as month,
                    SUM(CASE WHEN ca.account_type = 'Income' THEN t.amount ELSE 0 END) as monthly_income,
                    SUM(CASE WHEN da.account_type = 'Expense' THEN t.amount ELSE 0 END) as monthly_expense
                FROM transactions t
                LEFT JOIN accounts da ON t.debit_account_id = da.account_id
                LEFT JOIN accounts ca ON t.credit_account_id = ca.account_id
                WHERE t.user_id = $1 AND t.date >= NOW() - INTERVAL '6 months'
                GROUP BY TO_CHAR(t.date, 'YYYY-MM')
             ) monthly_data`,
            [userId]
        );

        // Get current net worth
        const netWorth = await pool.query(
            `SELECT SUM(CASE WHEN account_type = 'Asset' THEN current_balance ELSE 0 END) -
                    SUM(CASE WHEN account_type = 'Liability' THEN current_balance ELSE 0 END) as net_worth
             FROM accounts WHERE user_id = $1`,
            [userId]
        );

        const monthlyIncome = parseFloat(avgMonthly.rows[0].avg_income || 0);
        const monthlyExpenses = parseFloat(avgMonthly.rows[0].avg_expense || 0);
        const monthlySavings = monthlyIncome - monthlyExpenses;
        const savingsRate = monthlyIncome > 0 ? (monthlySavings / monthlyIncome * 100) : 0;
        const annualExpenses = monthlyExpenses * 12;
        const currentNetWorth = parseFloat(netWorth.rows[0].net_worth || 0);

        const fireNumber = annualExpenses / parseFloat(withdrawal_rate);
        const progress = fireNumber > 0 ? (currentNetWorth / fireNumber * 100) : 0;

        // Years to FIRE calculation (compound interest)
        let yearsToFIRE = 0;
        if (monthlySavings > 0 && fireNumber > currentNetWorth) {
            const r = parseFloat(annual_return) / 12;
            const target = fireNumber - currentNetWorth;
            yearsToFIRE = Math.log((target * r / monthlySavings) + 1) / (12 * Math.log(1 + r));
            yearsToFIRE = Math.max(0, Math.ceil(yearsToFIRE));
        }

        res.json({
            monthly_income: monthlyIncome,
            monthly_expenses: monthlyExpenses,
            monthly_savings: monthlySavings,
            savings_rate: Math.round(savingsRate * 100) / 100,
            annual_expenses: annualExpenses,
            current_net_worth: currentNetWorth,
            fire_number: fireNumber,
            progress_percentage: Math.round(progress * 100) / 100,
            years_to_fire: yearsToFIRE,
            fire_age: parseInt(current_age) + yearsToFIRE,
            assumptions: { annual_return: parseFloat(annual_return), withdrawal_rate: parseFloat(withdrawal_rate) }
        });
    } catch (error) {
        console.error('FIRE analytics error:', error);
        res.status(500).json({ error: 'Failed to calculate FIRE metrics' });
    }
});

// Tax summary (India-specific)
app.get('/api/analytics/tax-summary', authenticateToken, async (req, res) => {
    try {
        const { financial_year } = req.query;
        const fyStart = financial_year ? `${financial_year}-04-01` : `${new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0)}-04-01`;
        const fyEnd = financial_year ? `${parseInt(financial_year) + 1}-03-31` : `${new Date().getFullYear() + (new Date().getMonth() < 3 ? 0 : 1)}-03-31`;

        const result = await pool.query(
            `SELECT t.tax_category, t.category,
                    SUM(t.amount) as total_amount, COUNT(*) as count
             FROM transactions t
             WHERE t.user_id = $1 AND t.date BETWEEN $2 AND $3 AND t.tax_category IS NOT NULL
             GROUP BY t.tax_category, t.category
             ORDER BY t.tax_category, total_amount DESC`,
            [req.user.userId, fyStart, fyEnd]
        );

        // Group by tax category
        const taxSummary = {};
        result.rows.forEach(row => {
            if (!taxSummary[row.tax_category]) taxSummary[row.tax_category] = { total: 0, items: [] };
            taxSummary[row.tax_category].total += parseFloat(row.total_amount);
            taxSummary[row.tax_category].items.push(row);
        });

        res.json({ financial_year: `${fyStart.substring(0,4)}-${fyEnd.substring(0,4)}`, tax_categories: taxSummary });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch tax summary' });
    }
});

// Get categories list
app.get('/api/categories', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT DISTINCT category, COUNT(*) as count FROM transactions WHERE user_id = $1 GROUP BY category ORDER BY count DESC',
            [req.user.userId]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// =============================================
// HELPER FUNCTIONS
// =============================================

async function updateAccountBalance(client, accountId) {
    await client.query(
        `UPDATE accounts SET current_balance = COALESCE(
            (SELECT SUM(CASE WHEN debit_account_id = $1 THEN amount ELSE 0 END) -
                    SUM(CASE WHEN credit_account_id = $1 THEN amount ELSE 0 END)
             FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1), 0),
         updated_at = NOW()
         WHERE account_id = $1`,
        [accountId]
    );
}

async function createDefaultAccounts(userId) {
    const defaults = [
        // Assets
        ['Savings Bank', 'Asset', 'Bank Account'], ['Current Account', 'Asset', 'Bank Account'],
        ['Fixed Deposits', 'Asset', 'Fixed Deposit'], ['Cash in Hand', 'Asset', 'Cash'],
        ['Mutual Funds', 'Asset', 'Investment'], ['Stocks', 'Asset', 'Investment'],
        ['EPF', 'Asset', 'Retirement'], ['PPF', 'Asset', 'Retirement'],
        ['NPS', 'Asset', 'Retirement'], ['Gold', 'Asset', 'Investment'],
        ['Real Estate', 'Asset', 'Property'], ['Crypto', 'Asset', 'Investment'],
        // Liabilities
        ['Home Loan', 'Liability', 'Loan'], ['Car Loan', 'Liability', 'Loan'],
        ['Personal Loan', 'Liability', 'Loan'], ['Credit Card', 'Liability', 'Credit Card'],
        ['Education Loan', 'Liability', 'Loan'],
        // Income
        ['Salary', 'Income', 'Employment'], ['Interest Income', 'Income', 'Passive'],
        ['Dividend Income', 'Income', 'Passive'], ['Rental Income', 'Income', 'Passive'],
        ['Freelance Income', 'Income', 'Business'], ['Capital Gains', 'Income', 'Investment'],
        ['Gift Received', 'Income', 'Other'],
        // Expenses
        ['Groceries', 'Expense', 'Food'], ['Dining Out', 'Expense', 'Food'],
        ['Rent', 'Expense', 'Housing'], ['Electricity', 'Expense', 'Utilities'],
        ['Water', 'Expense', 'Utilities'], ['Internet', 'Expense', 'Utilities'],
        ['Mobile', 'Expense', 'Utilities'], ['Fuel', 'Expense', 'Transport'],
        ['Public Transport', 'Expense', 'Transport'], ['Medical', 'Expense', 'Health'],
        ['Health Insurance', 'Expense', 'Insurance'], ['Life Insurance', 'Expense', 'Insurance'],
        ['Vehicle Insurance', 'Expense', 'Insurance'], ['Shopping', 'Expense', 'Lifestyle'],
        ['Entertainment', 'Expense', 'Lifestyle'], ['Travel', 'Expense', 'Lifestyle'],
        ['Education', 'Expense', 'Education'], ['EMI Payment', 'Expense', 'Debt'],
        ['Tax Paid', 'Expense', 'Tax'], ['Donation', 'Expense', 'Tax-Saving'],
        ['Household', 'Expense', 'Home'], ['Personal Care', 'Expense', 'Personal'],
        ['Miscellaneous', 'Expense', 'Other'],
        // Equity
        ['Opening Balance', 'Equity', 'Capital'], ['Retained Earnings', 'Equity', 'Capital'],
    ];

    for (const [name, type, subType] of defaults) {
        await pool.query(
            'INSERT INTO accounts (user_id, account_name, account_type, sub_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [userId, name, type, subType]
        );
    }
}

// ===== AUTO-INITIALIZE DATABASE =====
async function initializeDatabase() {
    try {
        // Check if users table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users')
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('📦 First run detected - creating database tables...');
            const schemaPath = path.join(__dirname, 'database', 'schema.sql');
            if (fs.existsSync(schemaPath)) {
                const schema = fs.readFileSync(schemaPath, 'utf-8');
                await pool.query(schema);
                console.log('✅ Database tables created successfully!');
            } else {
                console.log('⚠️ schema.sql not found, creating minimal tables...');
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        email VARCHAR(255) UNIQUE NOT NULL,
                        password_hash VARCHAR(255) NOT NULL,
                        name VARCHAR(100) NOT NULL,
                        phone VARCHAR(20),
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        last_login TIMESTAMPTZ
                    );
                    CREATE TABLE IF NOT EXISTS accounts (
                        account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(user_id),
                        account_name VARCHAR(255) NOT NULL,
                        account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
                        sub_type VARCHAR(100),
                        description TEXT,
                        current_balance DECIMAL(15,2) DEFAULT 0,
                        currency VARCHAR(3) DEFAULT 'INR',
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW(),
                        UNIQUE(user_id, account_name)
                    );
                    CREATE TABLE IF NOT EXISTS transactions (
                        transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(user_id),
                        date DATE NOT NULL,
                        amount DECIMAL(15,2) NOT NULL,
                        description TEXT,
                        narration TEXT,
                        debit_account_id UUID NOT NULL REFERENCES accounts(account_id),
                        credit_account_id UUID NOT NULL REFERENCES accounts(account_id),
                        category VARCHAR(100) DEFAULT 'Uncategorized',
                        tax_category VARCHAR(100),
                        reference_number VARCHAR(100),
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date DESC);
                    CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(user_id, category);
                    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
                `);
                console.log('✅ Minimal database tables created!');
            }
        } else {
            console.log('✅ Database tables already exist');
        }
    } catch (error) {
        console.error('⚠️ Database initialization warning:', error.message);
    }
}

// ===== START SERVER =====
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Finance Tracker API running on port ${PORT}`);
        console.log(`📊 Health check: http://localhost:${PORT}/health`);
        console.log(`🔒 Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});
