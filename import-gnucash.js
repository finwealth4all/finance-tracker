// =============================================
// GnuCash CSV Import Script
// Run once on Render Shell: node import-gnucash.js
// =============================================

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── CONFIG ──
const CSV_FILE = path.join(__dirname, 'rachitgnu.csv');
const USER_EMAIL = 'reachrachit@gmail.com';

// ── CSV PARSER (handles quoted fields with commas) ──
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length >= headers.length) {
      const row = {};
      headers.forEach((h, idx) => { row[h.trim()] = fields[idx] || ''; });
      rows.push(row);
    }
  }
  return rows;
}

// ── MAP GnuCash Account Path → Account Type ──
function getAccountType(fullName) {
  if (fullName.startsWith('Assets:')) return 'Asset';
  if (fullName.startsWith('Liabilities:')) return 'Liability';
  if (fullName.startsWith('Income:')) return 'Income';
  if (fullName.startsWith('Expenses:')) return 'Expense';
  if (fullName.startsWith('Equity:')) return 'Equity';
  // Edge cases
  if (fullName === 'Imbalance-INR') return 'Equity';
  return 'Expense'; // default
}

// ── MAP GnuCash Account Path → Sub Type ──
function getSubType(fullName) {
  const lower = fullName.toLowerCase();
  if (lower.includes('savings account') || lower.includes('saving')) return 'Bank Account';
  if (lower.includes('cash')) return 'Cash';
  if (lower.includes('fix deposit') || lower.includes('fdr')) return 'Fixed Deposit';
  if (lower.includes('mutual fund') || lower.includes('mf')) return 'Investment';
  if (lower.includes('zerodha') || lower.includes('stocks') || lower.includes('groww')) return 'Investment';
  if (lower.includes('crypto')) return 'Investment';
  if (lower.includes('gold') || lower.includes('silver') || lower.includes('sgb')) return 'Investment';
  if (lower.includes('epf') || lower.includes('nps') || lower.includes('ppf') || lower.includes('retiral')) return 'Retirement';
  if (lower.includes('real estate') || lower.includes('plot') || lower.includes('godrej') || lower.includes('prestige') || lower.includes('jasola') || lower.includes('raheja')) return 'Property';
  if (lower.includes('car') || lower.includes('brezza') || lower.includes('vento')) return 'Property';
  if (lower.includes('wallet') || lower.includes('paytm') || lower.includes('airtel')) return 'Cash';
  if (lower.includes('loan') && lower.includes('liab')) return 'Loan';
  if (lower.includes('loan') && lower.includes('asset')) return 'Receivable';
  if (lower.includes('credit card')) return 'Credit Card';
  if (lower.includes('home loan')) return 'Loan';
  if (lower.includes('personal loan')) return 'Loan';
  if (lower.includes('insurance')) return 'Insurance';
  if (lower.includes('salary') || lower.includes('sal')) return 'Employment';
  if (lower.includes('interest')) return 'Passive';
  if (lower.includes('dividend')) return 'Passive';
  if (lower.includes('capital gain')) return 'Investment';
  if (lower.includes('income')) return 'Other';
  if (lower.includes('tax')) return 'Tax';
  if (lower.includes('grocery')) return 'Food';
  if (lower.includes('food')) return 'Food';
  if (lower.includes('fuel')) return 'Transport';
  if (lower.includes('rent')) return 'Housing';
  if (lower.includes('electric') || lower.includes('gas') || lower.includes('phone') || lower.includes('tatasky')) return 'Utilities';
  if (lower.includes('medical')) return 'Health';
  if (lower.includes('travel')) return 'Lifestyle';
  if (lower.includes('entertainment')) return 'Lifestyle';
  if (lower.includes('shopping') || lower.includes('clothes')) return 'Lifestyle';
  if (lower.includes('education')) return 'Education';
  if (lower.includes('donation')) return 'Tax-Saving';
  if (lower.includes('maintenance')) return 'Home';
  if (lower.includes('subscription')) return 'Lifestyle';
  return 'Other';
}

// ── Guess Category from Account Name ──
function guessCategory(debitAccName, creditAccName) {
  const expAcc = debitAccName.startsWith('Expenses:') ? debitAccName : creditAccName;
  const lower = expAcc.toLowerCase();
  if (lower.includes('grocery')) return 'Groceries';
  if (lower.includes('food')) return 'Food';
  if (lower.includes('fuel')) return 'Fuel';
  if (lower.includes('rent')) return 'Rent';
  if (lower.includes('electric')) return 'Electricity';
  if (lower.includes('gas')) return 'Gas';
  if (lower.includes('phone')) return 'Mobile';
  if (lower.includes('tatasky')) return 'Subscription';
  if (lower.includes('subscription')) return 'Subscription';
  if (lower.includes('medical')) return 'Medical';
  if (lower.includes('insurance')) return 'Insurance';
  if (lower.includes('travel')) return 'Travel';
  if (lower.includes('entertainment')) return 'Entertainment';
  if (lower.includes('shopping')) return 'Shopping';
  if (lower.includes('clothes')) return 'Shopping';
  if (lower.includes('education')) return 'Education';
  if (lower.includes('donation')) return 'Donation';
  if (lower.includes('maintenance')) return 'Household';
  if (lower.includes('income tax')) return 'Tax Paid';
  if (lower.includes('tax')) return 'Tax';
  if (lower.includes('salary') && lower.includes('income')) return 'Salary';
  if (lower.includes('salary') && lower.includes('expense')) return 'Staff Salary';
  if (lower.includes('interest')) return 'Interest';
  if (lower.includes('dividend')) return 'Dividend';
  if (lower.includes('capital gain')) return 'Capital Gains';
  if (lower.includes('gift')) return 'Gift';
  if (lower.includes('bank service')) return 'Bank Charges';
  if (lower.includes('miscellaneous')) return 'Miscellaneous';
  if (lower.includes('relocation')) return 'Relocation';
  return 'Uncategorized';
}

// ── Parse DD-MM-YYYY → YYYY-MM-DD ──
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
  }
  return dateStr;
}

// ══════════════════════════════════════════
// MAIN IMPORT
// ══════════════════════════════════════════
async function main() {
  const client = await pool.connect();
  
  try {
    console.log('📂 Reading CSV file...');
    const rows = parseCSV(CSV_FILE);
    console.log(`   Found ${rows.length} rows`);

    // ── Step 1: Get user_id ──
    console.log('\n👤 Finding user...');
    const userResult = await client.query('SELECT user_id FROM users WHERE email = $1', [USER_EMAIL]);
    if (userResult.rows.length === 0) {
      console.error('❌ User not found! Make sure you have registered with:', USER_EMAIL);
      return;
    }
    const userId = userResult.rows[0].user_id;
    console.log(`   User ID: ${userId}`);

    // ── Step 2: Collect unique accounts from CSV ──
    console.log('\n🏦 Collecting unique accounts...');
    const uniqueAccounts = new Map();
    rows.forEach(row => {
      const fullName = row['Full Account Name'];
      if (fullName && fullName !== 'Full Account Name' && !uniqueAccounts.has(fullName)) {
        uniqueAccounts.set(fullName, {
          fullName,
          shortName: row['Account Name'] || fullName.split(':').pop(),
          type: getAccountType(fullName),
          subType: getSubType(fullName),
        });
      }
    });
    console.log(`   Found ${uniqueAccounts.size} unique accounts`);

    // ── Step 3: Delete existing data for clean import ──
    console.log('\n🗑️  Cleaning existing data for this user...');
    await client.query('BEGIN');
    
    const existingTx = await client.query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]);
    const existingAcc = await client.query('SELECT COUNT(*) FROM accounts WHERE user_id = $1', [userId]);
    console.log(`   Existing: ${existingTx.rows[0].count} transactions, ${existingAcc.rows[0].count} accounts`);
    
    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    console.log('   ✅ Cleaned');

    // ── Step 4: Create accounts (handle duplicate short names) ──
    console.log('\n📝 Creating accounts...');
    const accountIdMap = new Map(); // fullName → account_id

    // Find duplicate short names
    const shortNameCount = new Map();
    for (const [fullName, acc] of uniqueAccounts) {
      const key = acc.shortName;
      shortNameCount.set(key, (shortNameCount.get(key) || 0) + 1);
    }

    for (const [fullName, acc] of uniqueAccounts) {
      const key = acc.shortName;
      // If short name is duplicate within same type, use a more specific name
      let displayName = acc.shortName;
      if (shortNameCount.get(key) > 1) {
        // Use last 2 parts of path for uniqueness, e.g. "Taxes > Income Tax"
        const parts = fullName.split(':');
        displayName = parts.length >= 2 
          ? `${parts[parts.length - 2].trim()} > ${parts[parts.length - 1].trim()}`
          : fullName;
      }

      const result = await client.query(
        `INSERT INTO accounts (user_id, account_name, account_type, sub_type, description, currency)
         VALUES ($1, $2, $3, $4, $5, 'INR') RETURNING account_id`,
        [userId, displayName.substring(0, 250), acc.type, acc.subType, fullName]
      );
      accountIdMap.set(fullName, result.rows[0].account_id);
    }
    console.log(`   ✅ Created ${accountIdMap.size} accounts`);

    // ── Step 5: Group rows by Transaction ID (pair debit & credit) ──
    console.log('\n🔗 Pairing transactions...');
    const txGroups = new Map();
    rows.forEach(row => {
      const txId = row['Transaction ID'];
      if (!txId || txId === 'Transaction ID') return;
      if (!txGroups.has(txId)) txGroups.set(txId, []);
      txGroups.get(txId).push(row);
    });
    console.log(`   Found ${txGroups.size} unique transactions`);

    // ── Step 6: Insert transactions ──
    console.log('\n💸 Importing transactions...');
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let lastPercent = 0;
    const totalTx = txGroups.size;

    for (const [txId, group] of txGroups) {
      try {
        // GnuCash: positive amount = debit, negative = credit
        // Find the positive (debit) and negative (credit) entries
        let debitRow = null;
        let creditRow = null;

        if (group.length === 2) {
          const amt0 = parseFloat(group[0]['Amount Num.'] || 0);
          const amt1 = parseFloat(group[1]['Amount Num.'] || 0);
          if (amt0 >= 0) { debitRow = group[0]; creditRow = group[1]; }
          else { debitRow = group[1]; creditRow = group[0]; }
        } else if (group.length > 2) {
          // Split transaction: multiple entries
          // Find the one with positive amount as main debit
          const positives = group.filter(r => parseFloat(r['Amount Num.'] || 0) > 0);
          const negatives = group.filter(r => parseFloat(r['Amount Num.'] || 0) < 0);
          
          if (positives.length > 0 && negatives.length > 0) {
            // Use first positive as debit, first negative as credit
            debitRow = positives[0];
            creditRow = negatives[0];
          } else {
            skipped++;
            continue;
          }
        } else {
          skipped++;
          continue;
        }

        const amount = Math.abs(parseFloat(debitRow['Amount Num.'] || 0));
        if (amount === 0) { skipped++; continue; }

        const debitAccName = debitRow['Full Account Name'];
        const creditAccName = creditRow['Full Account Name'];
        const debitAccId = accountIdMap.get(debitAccName);
        const creditAccId = accountIdMap.get(creditAccName);

        if (!debitAccId || !creditAccId) { skipped++; continue; }
        if (debitAccId === creditAccId) { skipped++; continue; }

        const date = parseDate(debitRow['Date']);
        if (!date) { skipped++; continue; }

        const description = (debitRow['Description'] || '').substring(0, 500);
        const memo = (debitRow['Memo'] || '').substring(0, 500);
        const refNumber = (debitRow['Number'] || '').substring(0, 100);
        const category = guessCategory(debitAccName, creditAccName);

        await client.query(
          `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, reference_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [userId, date, amount, description, memo, debitAccId, creditAccId, category, refNumber || null]
        );
        imported++;

        // Progress indicator
        const percent = Math.floor((imported + skipped + errors) / totalTx * 100);
        if (percent >= lastPercent + 10) {
          console.log(`   ... ${percent}% done (${imported} imported, ${skipped} skipped)`);
          lastPercent = percent;
        }
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`   ⚠️ Error on tx ${txId}: ${err.message}`);
      }
    }

    // ── Step 7: Update all account balances ──
    console.log('\n📊 Recalculating account balances...');
    for (const [fullName, accId] of accountIdMap) {
      await client.query(
        `UPDATE accounts SET current_balance = COALESCE(
          (SELECT SUM(CASE WHEN debit_account_id = $1 THEN amount ELSE 0 END) -
                  SUM(CASE WHEN credit_account_id = $1 THEN amount ELSE 0 END)
           FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1), 0),
         updated_at = NOW()
         WHERE account_id = $1`,
        [accId]
      );
    }

    await client.query('COMMIT');

    console.log('\n══════════════════════════════════════');
    console.log('✅ IMPORT COMPLETE!');
    console.log('══════════════════════════════════════');
    console.log(`   Transactions imported: ${imported}`);
    console.log(`   Transactions skipped:  ${skipped}`);
    console.log(`   Errors:               ${errors}`);
    console.log(`   Accounts created:     ${accountIdMap.size}`);
    console.log('══════════════════════════════════════\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ IMPORT FAILED! All changes rolled back.');
    console.error('   Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
