// ===================================================
// STATEMENT IMPORT SERVICE - statement-import.js
// Smart bank/CC statement import with auto-classification
// and human-in-the-loop review
// ===================================================
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.csv', '.xls', '.xlsx'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only PDF, CSV, and Excel files are supported'));
    }
});

// ===================================================
// DATABASE SETUP - Creates tables on first run
// ===================================================
async function initImportTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS staged_transactions (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            batch_id VARCHAR(50) NOT NULL,
            date DATE,
            description TEXT,
            amount DECIMAL(15,2),
            transaction_type VARCHAR(10) DEFAULT 'debit',
            balance DECIMAL(15,2),
            suggested_category VARCHAR(100) DEFAULT 'Uncategorized',
            suggested_debit_account_id INT,
            suggested_credit_account_id INT,
            confidence DECIMAL(3,2) DEFAULT 0,
            status VARCHAR(20) DEFAULT 'pending',
            source_file VARCHAR(255),
            raw_text TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS category_rules (
            id SERIAL PRIMARY KEY,
            user_id INT NOT NULL,
            pattern VARCHAR(500) NOT NULL,
            category VARCHAR(100),
            debit_account_id INT,
            credit_account_id INT,
            account_type VARCHAR(20),
            hit_count INT DEFAULT 1,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, pattern)
        );
        CREATE INDEX IF NOT EXISTS idx_staged_batch ON staged_transactions(user_id, batch_id);
        CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_transactions(status);
        CREATE INDEX IF NOT EXISTS idx_rules_user ON category_rules(user_id);
    `);
    console.log('✅ Import tables ready');
}

// ===================================================
// PARSERS - Extract transactions from different formats
// ===================================================

// --- Generic date detection ---
function parseDate(str) {
    if (!str) return null;
    str = str.trim();
    // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    let m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // YYYY-MM-DD
    m = str.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // DD Mon YYYY or DD-Mon-YYYY (e.g., 15 Jan 2024, 15-Jan-2024)
    const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    m = str.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{2,4})$/);
    if (m) {
        const mon = months[m[2].toLowerCase()];
        const yr = m[3].length === 2 ? '20' + m[3] : m[3];
        if (mon) return `${yr}-${mon}-${m[1].padStart(2,'0')}`;
    }
    // Try native Date parse as fallback
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
}

// --- Parse amount (Indian format: 1,23,456.78) ---
function parseAmount(str) {
    if (!str) return 0;
    str = str.toString().trim().replace(/[₹\s]/g, '');
    // Remove Indian-style commas (1,23,456.78)
    const cleaned = str.replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.abs(num);
}

// --- CSV Parser ---
function parseCSV(content) {
    const Papa = require('papaparse');
    const result = Papa.parse(content, { header: true, skipEmptyLines: true, dynamicTyping: false });
    if (!result.data || result.data.length === 0) return [];

    // Auto-detect column names
    const headers = Object.keys(result.data[0] || {}).map(h => h.toLowerCase().trim());
    const findCol = (...names) => {
        const actual = Object.keys(result.data[0] || {});
        for (const name of names) {
            const idx = headers.findIndex(h => h.includes(name.toLowerCase()));
            if (idx >= 0) return actual[idx];
        }
        return null;
    };

    const dateCol = findCol('date', 'txn date', 'transaction date', 'value date', 'posting date');
    const descCol = findCol('description', 'narration', 'particulars', 'details', 'transaction remarks', 'remarks');
    const debitCol = findCol('debit', 'withdrawal', 'dr', 'withdrawal amt', 'withdrawal amount');
    const creditCol = findCol('credit', 'deposit', 'cr', 'deposit amt', 'deposit amount');
    const amountCol = findCol('amount', 'transaction amount');
    const balCol = findCol('balance', 'closing balance', 'available balance', 'running balance');
    const typeCol = findCol('type', 'cr/dr', 'transaction type');

    const transactions = [];
    for (const row of result.data) {
        const date = parseDate(dateCol ? row[dateCol] : '');
        if (!date) continue;

        const desc = descCol ? (row[descCol] || '').trim() : '';
        let amount = 0;
        let txType = 'debit';

        if (debitCol && creditCol) {
            // Separate debit/credit columns
            const dr = parseAmount(row[debitCol]);
            const cr = parseAmount(row[creditCol]);
            if (dr > 0) { amount = dr; txType = 'debit'; }
            else if (cr > 0) { amount = cr; txType = 'credit'; }
            else continue;
        } else if (amountCol) {
            // Single amount column
            amount = parseAmount(row[amountCol]);
            if (amount === 0) continue;
            // Check type column
            if (typeCol) {
                const t = (row[typeCol] || '').toLowerCase().trim();
                txType = (t === 'cr' || t === 'credit' || t === 'c') ? 'credit' : 'debit';
            } else {
                // Positive = credit (deposit), negative = debit (withdrawal)
                const raw = parseFloat((row[amountCol] || '').toString().replace(/[₹,\s]/g, ''));
                txType = raw >= 0 ? 'credit' : 'debit';
            }
        } else continue;

        const balance = balCol ? parseAmount(row[balCol]) : null;

        transactions.push({ date, description: desc, amount, transaction_type: txType, balance });
    }
    return transactions;
}

// --- Excel Parser ---
function parseExcel(filePath) {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return parseCSV(csv);
}

// --- PDF Parser (using pdfjs-dist directly for proper password support) ---
async function parsePDF(filePath, password) {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const dataBuffer = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(dataBuffer);

    // Load PDF with password support
    const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        password: password || undefined,
        useSystemFonts: true
    });

    // Handle password prompts from PDF.js
    loadingTask.onPassword = (updatePassword, reason) => {
        if (reason === 1 && password) {
            // First request — supply the password
            updatePassword(password);
        } else if (reason === 2) {
            // Wrong password
            throw new Error('PDF is password-protected. The password you provided is incorrect.');
        } else {
            throw new Error('PDF is password-protected. Please provide the correct password.');
        }
    };

    let pdfDoc;
    try {
        pdfDoc = await loadingTask.promise;
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('password') || msg.includes('encrypted')) {
            if (password) {
                throw new Error('PDF is password-protected. The password you provided is incorrect. Please check and try again.');
            }
            throw new Error('PDF is password-protected. Please provide the correct password.');
        }
        throw err;
    }

    // Extract text from all pages
    const textParts = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str).join(' ');
        textParts.push(pageText);
    }
    const text = textParts.join('\n');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Detect bank from content
    const fullText = text.toLowerCase();
    let bankType = 'generic';
    if (fullText.includes('hdfc bank')) bankType = 'hdfc';
    else if (fullText.includes('state bank of india') || fullText.includes('sbi')) bankType = 'sbi';
    else if (fullText.includes('icici bank')) bankType = 'icici';
    else if (fullText.includes('hdfc') && (fullText.includes('credit card') || fullText.includes('card number'))) bankType = 'hdfc_cc';
    else if (fullText.includes('sbi') && (fullText.includes('credit card') || fullText.includes('card number') || fullText.includes('sbicard'))) bankType = 'sbi_cc';
    else if (fullText.includes('icici') && (fullText.includes('credit card') || fullText.includes('card number'))) bankType = 'icici_cc';

    console.log(`Detected bank type: ${bankType}`);

    const transactions = [];
    // Date pattern at start of line
    const dateRegex = /^(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}[\s\-][A-Za-z]{3}[\s\-]\d{2,4})/;
    // Amount pattern (Indian format)
    const amountRegex = /[\d,]+\.\d{2}/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const dateMatch = line.match(dateRegex);
        if (!dateMatch) continue;

        const date = parseDate(dateMatch[1]);
        if (!date) continue;

        // Extract all amounts from the line
        const amounts = [];
        let amtMatch;
        const amtStr = line.slice(dateMatch[0].length);
        const amtRegex2 = /[\d,]+\.\d{2}/g;
        while ((amtMatch = amtRegex2.exec(amtStr)) !== null) {
            amounts.push({ value: parseAmount(amtMatch[0]), index: amtMatch.index });
        }

        if (amounts.length === 0) continue;

        // Extract description: text between date and first amount
        const firstAmtPos = line.indexOf(amounts[0].value.toFixed(2).replace(/(\d)(?=(\d{2})+\d\.)/g, '$1,'));
        let description = '';
        if (amounts.length > 0) {
            // Get text between date and amounts area
            const afterDate = line.slice(dateMatch[0].length);
            const match = afterDate.match(/^[\s]*(.*?)[\s]*[\d,]+\.\d{2}/);
            if (match) description = match[1].replace(/\s+/g, ' ').trim();
        }

        // Sometimes description spans multiple lines
        if (description.length < 5 && i + 1 < lines.length && !lines[i + 1].match(dateRegex)) {
            description = (description + ' ' + lines[i + 1]).trim();
        }

        // Determine debit/credit based on number of amount columns
        let amount, txType, balance;

        if (amounts.length >= 3) {
            // Pattern: Withdrawal | Deposit | Balance (most bank statements)
            // Find which column has the value (non-zero)
            if (amounts[0].value > 0 && (amounts.length < 3 || amounts[1].value === 0)) {
                amount = amounts[0].value;
                txType = 'debit';
                balance = amounts[amounts.length - 1].value;
            } else if (amounts.length >= 2 && amounts[1].value > 0) {
                amount = amounts[1].value;
                txType = 'credit';
                balance = amounts[amounts.length - 1].value;
            } else {
                amount = amounts[0].value;
                txType = 'debit';
                balance = amounts[amounts.length - 1].value;
            }
        } else if (amounts.length === 2) {
            // Could be: Amount | Balance  OR  two amounts
            amount = amounts[0].value;
            balance = amounts[1].value;
            // Heuristic: if second amount is much larger, it's likely the balance
            txType = 'debit'; // Default, user can correct
        } else {
            // Single amount (common in CC statements)
            amount = amounts[0].value;
            txType = 'debit';
            balance = null;
        }

        // Credit card statements: most entries are debits (purchases)
        if (bankType.includes('_cc')) {
            txType = 'debit';
            // Check for CR/credit indicators
            if (line.toLowerCase().includes(' cr') || line.toLowerCase().includes('credit') ||
                line.toLowerCase().includes('refund') || line.toLowerCase().includes('cashback') ||
                line.toLowerCase().includes('reversal') || line.toLowerCase().includes('payment received')) {
                txType = 'credit';
            }
        }

        if (amount > 0) {
            transactions.push({ date, description, amount, transaction_type: txType, balance });
        }
    }

    return transactions;
}

// ===================================================
// AUTO-CLASSIFICATION ENGINE
// ===================================================
async function autoClassify(pool, userId, transactions, sourceAccountId) {
    // Fetch user's category rules
    const rulesResult = await pool.query(
        'SELECT * FROM category_rules WHERE user_id = $1 ORDER BY hit_count DESC',
        [userId]
    );
    const rules = rulesResult.rows;

    // Fetch user's accounts
    const accountsResult = await pool.query(
        'SELECT account_id, account_name, account_type, sub_type FROM accounts WHERE user_id = $1',
        [userId]
    );
    const accounts = accountsResult.rows;

    // Find the source account
    const sourceAccount = sourceAccountId ? accounts.find(a => a.account_id === parseInt(sourceAccountId)) : null;

    // Default category mappings (Indian context)
    const defaultRules = [
        { patterns: ['swiggy', 'zomato', 'uber eats', 'food', 'restaurant', 'hotel', 'dhaba', 'cafe', 'pizza', 'dominos', 'mcdonalds', 'kfc', 'burger'], category: 'Food' },
        { patterns: ['bigbasket', 'blinkit', 'zepto', 'dmart', 'grocery', 'reliance fresh', 'nature basket', 'more supermarket', 'supermarket', 'milk', 'vegetables'], category: 'Grocery' },
        { patterns: ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'shopping', 'croma', 'reliance digital'], category: 'Shopping' },
        { patterns: ['uber', 'ola', 'rapido', 'metro', 'irctc', 'railway', 'makemytrip', 'goibibo', 'cleartrip', 'yatra', 'indigo', 'air india', 'spicejet', 'vistara', 'bus', 'cab'], category: 'Travel' },
        { patterns: ['petrol', 'diesel', 'fuel', 'hp pump', 'bharat petroleum', 'indian oil', 'shell', 'bpcl', 'hpcl', 'iocl'], category: 'Fuel' },
        { patterns: ['netflix', 'hotstar', 'prime video', 'spotify', 'youtube', 'disney', 'zee5', 'sony liv', 'jio cinema', 'subscription'], category: 'Subscription' },
        { patterns: ['electricity', 'bescom', 'tata power', 'adani', 'torrent power', 'light bill', 'water', 'gas', 'lpg', 'pipeline'], category: 'Utilities' },
        { patterns: ['airtel', 'jio', 'vodafone', 'vi ', 'bsnl', 'mobile', 'recharge', 'broadband', 'wifi', 'internet', 'act fibernet'], category: 'Telecom' },
        { patterns: ['lic', 'insurance', 'icici pru', 'hdfc life', 'sbi life', 'max life', 'star health', 'bajaj allianz', 'policy', 'premium'], category: 'Insurance' },
        { patterns: ['hospital', 'doctor', 'medical', 'pharma', 'medicine', 'apollo', 'medplus', 'netmeds', 'practo', 'diagnostic', 'lab', 'pathology', 'clinic', 'health'], category: 'Medical' },
        { patterns: ['rent', 'house rent', 'pg rent', 'maintenance', 'society', 'association'], category: 'Housing' },
        { patterns: ['emi', 'loan', 'equated monthly', 'home loan', 'car loan', 'personal loan'], category: 'EMI Payment' },
        { patterns: ['salary', 'wages', 'payroll', 'stipend'], category: 'Salary' },
        { patterns: ['interest', 'int.', 'fd interest', 'rd interest', 'savings interest'], category: 'Interest' },
        { patterns: ['dividend', 'div.'], category: 'Dividend' },
        { patterns: ['atm', 'cash withdrawal', 'neft', 'rtgs', 'imps', 'upi', 'transfer'], category: 'Transfer' },
        { patterns: ['tax', 'tds', 'gst', 'income tax', 'advance tax', 'self assessment'], category: 'Tax' },
        { patterns: ['education', 'school', 'college', 'university', 'tuition', 'course', 'exam', 'udemy', 'coursera'], category: 'Education' },
        { patterns: ['gym', 'fitness', 'sports', 'movie', 'pvr', 'inox', 'bookmyshow', 'entertainment', 'gaming'], category: 'Entertainment' },
        { patterns: ['donation', 'charity', 'ngo'], category: 'Donation' },
    ];

    return transactions.map(tx => {
        const desc = (tx.description || '').toLowerCase();
        let category = 'Uncategorized';
        let confidence = 0;
        let debitAccountId = null;
        let creditAccountId = null;

        // 1. First try user's learned rules (highest priority)
        for (const rule of rules) {
            if (desc.includes(rule.pattern.toLowerCase())) {
                category = rule.category;
                debitAccountId = rule.debit_account_id;
                creditAccountId = rule.credit_account_id;
                confidence = Math.min(0.95, 0.7 + (rule.hit_count * 0.05));
                break;
            }
        }

        // 2. If no user rule matched, try default rules
        if (category === 'Uncategorized') {
            for (const rule of defaultRules) {
                if (rule.patterns.some(p => desc.includes(p))) {
                    category = rule.category;
                    confidence = 0.5;
                    break;
                }
            }
        }

        // 3. Set accounts based on transaction type and source
        if (sourceAccount) {
            if (tx.transaction_type === 'debit') {
                // Money going OUT of bank/CC
                creditAccountId = creditAccountId || sourceAccount.account_id;
                // Find matching expense account
                if (!debitAccountId) {
                    const expAcc = accounts.find(a => a.account_type === 'Expense' && a.account_name.toLowerCase().includes(category.toLowerCase()));
                    debitAccountId = expAcc?.account_id || null;
                }
            } else {
                // Money coming IN to bank (income, refund, transfer)
                debitAccountId = debitAccountId || sourceAccount.account_id;
                // Find matching income account
                if (!creditAccountId) {
                    const incAcc = accounts.find(a => a.account_type === 'Income' && a.account_name.toLowerCase().includes(category.toLowerCase()));
                    creditAccountId = incAcc?.account_id || null;
                }
            }
        }

        return {
            ...tx,
            suggested_category: category,
            suggested_debit_account_id: debitAccountId,
            suggested_credit_account_id: creditAccountId,
            confidence
        };
    });
}

// ===================================================
// ROUTES
// ===================================================
function createImportRoutes(pool, authenticateToken) {

    // --- Upload & Parse Statement ---
    router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

            const userId = req.user.userId;
            const ext = path.extname(req.file.originalname).toLowerCase();
            const password = req.body.password || null;
            const sourceAccountId = req.body.source_account_id || null;
            const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            let transactions = [];

            console.log(`Import: Processing ${req.file.originalname} (${ext}) for user ${userId}`);

            // Parse based on file type
            if (ext === '.csv') {
                const content = fs.readFileSync(req.file.path, 'utf-8');
                transactions = parseCSV(content);
            } else if (ext === '.xlsx' || ext === '.xls') {
                transactions = parseExcel(req.file.path);
            } else if (ext === '.pdf') {
                transactions = await parsePDF(req.file.path, password);
            }

            // Clean up uploaded file
            try { fs.unlinkSync(req.file.path); } catch {}

            if (transactions.length === 0) {
                return res.status(400).json({
                    error: 'No transactions found in the file. Please check the format.',
                    hint: 'For CSV: ensure columns like Date, Description, Debit/Credit or Amount exist. For PDF: ensure it contains a transaction table.'
                });
            }

            // Auto-classify
            const classified = await autoClassify(pool, userId, transactions, sourceAccountId);

            // Insert into staging table
            const insertQuery = `
                INSERT INTO staged_transactions (user_id, batch_id, date, description, amount, transaction_type, balance, suggested_category, suggested_debit_account_id, suggested_credit_account_id, confidence, status, source_file)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
                RETURNING id
            `;

            let inserted = 0;
            for (const tx of classified) {
                try {
                    await pool.query(insertQuery, [
                        userId, batchId, tx.date, tx.description, tx.amount,
                        tx.transaction_type, tx.balance, tx.suggested_category,
                        tx.suggested_debit_account_id, tx.suggested_credit_account_id,
                        tx.confidence, req.file.originalname
                    ]);
                    inserted++;
                } catch (err) {
                    console.error('Staging insert error:', err.message);
                }
            }

            res.json({
                batch_id: batchId,
                file: req.file.originalname,
                total_parsed: transactions.length,
                total_staged: inserted,
                message: `Parsed ${transactions.length} transactions. Please review and confirm.`
            });

        } catch (err) {
            console.error('Import upload error:', err);
            // Clean up file on error
            if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
            res.status(500).json({ error: err.message || 'Failed to process file' });
        }
    });

    // --- Get Staged Transactions for Review ---
    router.get('/staged', authenticateToken, async (req, res) => {
        try {
            const { batch_id } = req.query;
            let query = `
                SELECT s.*, 
                    da.account_name as suggested_debit_name, da.account_type as debit_type,
                    ca.account_name as suggested_credit_name, ca.account_type as credit_type
                FROM staged_transactions s
                LEFT JOIN accounts da ON s.suggested_debit_account_id = da.account_id
                LEFT JOIN accounts ca ON s.suggested_credit_account_id = ca.account_id
                WHERE s.user_id = $1 AND s.status = 'pending'
            `;
            const params = [req.user.userId];
            if (batch_id) {
                query += ' AND s.batch_id = $2';
                params.push(batch_id);
            }
            query += ' ORDER BY s.date ASC, s.id ASC';

            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (err) {
            console.error('Staged fetch error:', err);
            res.status(500).json({ error: 'Failed to fetch staged transactions' });
        }
    });

    // --- Update a Staged Transaction ---
    router.put('/staged/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { suggested_category, suggested_debit_account_id, suggested_credit_account_id, transaction_type, description, amount, status } = req.body;

            const fields = [];
            const values = [];
            let idx = 1;

            if (suggested_category !== undefined) { fields.push(`suggested_category = $${idx++}`); values.push(suggested_category); }
            if (suggested_debit_account_id !== undefined) { fields.push(`suggested_debit_account_id = $${idx++}`); values.push(suggested_debit_account_id || null); }
            if (suggested_credit_account_id !== undefined) { fields.push(`suggested_credit_account_id = $${idx++}`); values.push(suggested_credit_account_id || null); }
            if (transaction_type !== undefined) { fields.push(`transaction_type = $${idx++}`); values.push(transaction_type); }
            if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
            if (amount !== undefined) { fields.push(`amount = $${idx++}`); values.push(amount); }
            if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }

            if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

            values.push(parseInt(id));
            values.push(req.user.userId);

            const result = await pool.query(
                `UPDATE staged_transactions SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
                values
            );

            if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
            res.json(result.rows[0]);
        } catch (err) {
            console.error('Staged update error:', err);
            res.status(500).json({ error: 'Failed to update' });
        }
    });

    // --- Bulk Update Staged Transactions ---
    router.put('/staged-bulk', authenticateToken, async (req, res) => {
        try {
            const { ids, updates } = req.body;
            if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });

            let updated = 0;
            for (const id of ids) {
                try {
                    const fields = [];
                    const values = [];
                    let idx = 1;
                    if (updates.suggested_category) { fields.push(`suggested_category = $${idx++}`); values.push(updates.suggested_category); }
                    if (updates.suggested_debit_account_id) { fields.push(`suggested_debit_account_id = $${idx++}`); values.push(updates.suggested_debit_account_id); }
                    if (updates.suggested_credit_account_id) { fields.push(`suggested_credit_account_id = $${idx++}`); values.push(updates.suggested_credit_account_id); }
                    if (updates.status) { fields.push(`status = $${idx++}`); values.push(updates.status); }
                    if (updates.transaction_type) { fields.push(`transaction_type = $${idx++}`); values.push(updates.transaction_type); }

                    if (fields.length > 0) {
                        values.push(id, req.user.userId);
                        await pool.query(`UPDATE staged_transactions SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`, values);
                        updated++;
                    }
                } catch {}
            }
            res.json({ updated });
        } catch (err) {
            res.status(500).json({ error: 'Bulk update failed' });
        }
    });

    // --- Confirm Import: Move Staged → Transactions ---
    router.post('/confirm', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { batch_id } = req.body;

            // Get all approved/pending staged transactions for this batch
            let query = `SELECT * FROM staged_transactions WHERE user_id = $1 AND status != 'rejected'`;
            const params = [userId];
            if (batch_id) {
                query += ` AND batch_id = $2`;
                params.push(batch_id);
            }
            const staged = await pool.query(query, params);

            if (staged.rows.length === 0) {
                return res.status(400).json({ error: 'No transactions to confirm' });
            }

            let imported = 0, skipped = 0, errors = [];

            for (const tx of staged.rows) {
                try {
                    if (!tx.suggested_debit_account_id || !tx.suggested_credit_account_id) {
                        skipped++;
                        continue;
                    }

                    // Check for duplicate (same date, amount, description)
                    const dupCheck = await pool.query(
                        `SELECT transaction_id FROM transactions WHERE user_id = $1 AND date = $2 AND amount = $3 AND description = $4 LIMIT 1`,
                        [userId, tx.date, tx.amount, tx.description]
                    );
                    if (dupCheck.rows.length > 0) {
                        skipped++;
                        continue;
                    }

                    // Insert into transactions table
                    await pool.query(
                        `INSERT INTO transactions (user_id, date, amount, description, debit_account_id, credit_account_id, category, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                        [userId, tx.date, tx.amount, tx.description, tx.suggested_debit_account_id, tx.suggested_credit_account_id, tx.suggested_category]
                    );
                    imported++;

                    // Learn from user's classification
                    if (tx.description && tx.suggested_category !== 'Uncategorized') {
                        // Extract key pattern from description (first 3-4 significant words)
                        const words = tx.description.replace(/[^a-zA-Z\s]/g, ' ').trim().split(/\s+/).filter(w => w.length > 2);
                        const pattern = words.slice(0, 4).join(' ').toLowerCase();
                        if (pattern.length >= 3) {
                            try {
                                await pool.query(`
                                    INSERT INTO category_rules (user_id, pattern, category, debit_account_id, credit_account_id, hit_count)
                                    VALUES ($1, $2, $3, $4, $5, 1)
                                    ON CONFLICT (user_id, pattern) DO UPDATE SET
                                        category = EXCLUDED.category,
                                        debit_account_id = EXCLUDED.debit_account_id,
                                        credit_account_id = EXCLUDED.credit_account_id,
                                        hit_count = category_rules.hit_count + 1,
                                        updated_at = NOW()
                                `, [userId, pattern, tx.suggested_category, tx.suggested_debit_account_id, tx.suggested_credit_account_id]);
                            } catch {} // Ignore rule learning errors
                        }
                    }

                } catch (err) {
                    errors.push(`Row ${tx.id}: ${err.message}`);
                }
            }

            // Clear confirmed staged transactions
            await pool.query(
                batch_id
                    ? 'DELETE FROM staged_transactions WHERE user_id = $1 AND batch_id = $2'
                    : 'DELETE FROM staged_transactions WHERE user_id = $1 AND status != \'rejected\'',
                batch_id ? [userId, batch_id] : [userId]
            );

            // Update account balances
            try {
                await pool.query(`
                    UPDATE accounts a SET calculated_balance = (
                        SELECT COALESCE(SUM(CASE WHEN t.debit_account_id = a.account_id THEN t.amount ELSE 0 END), 0)
                             - COALESCE(SUM(CASE WHEN t.credit_account_id = a.account_id THEN t.amount ELSE 0 END), 0)
                             + COALESCE(a.opening_balance, 0)
                        FROM transactions t WHERE t.debit_account_id = a.account_id OR t.credit_account_id = a.account_id
                    ) WHERE a.user_id = $1
                `, [userId]);
            } catch {}

            res.json({
                imported,
                skipped,
                errors: errors.slice(0, 5),
                message: `Imported ${imported} transactions${skipped > 0 ? `, skipped ${skipped} (duplicates or missing accounts)` : ''}`
            });

        } catch (err) {
            console.error('Confirm import error:', err);
            res.status(500).json({ error: 'Failed to confirm import' });
        }
    });

    // --- Clear Staged Transactions ---
    router.delete('/staged', authenticateToken, async (req, res) => {
        try {
            const { batch_id } = req.query;
            if (batch_id) {
                await pool.query('DELETE FROM staged_transactions WHERE user_id = $1 AND batch_id = $2', [req.user.userId, batch_id]);
            } else {
                await pool.query('DELETE FROM staged_transactions WHERE user_id = $1', [req.user.userId]);
            }
            res.json({ message: 'Cleared' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to clear' });
        }
    });

    // --- Get User's Category Rules ---
    router.get('/rules', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT * FROM category_rules WHERE user_id = $1 ORDER BY hit_count DESC LIMIT 200',
                [req.user.userId]
            );
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch rules' });
        }
    });

    return router;
}

module.exports = { createImportRoutes, initImportTables };
