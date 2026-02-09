// =============================================
// GnuCash CSV Import Script v2
// Fixes: split transactions, categories, balances
// Run on Render Shell: node import-gnucash-v2.js
// =============================================

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CSV_FILE = path.join(__dirname, 'rachitgnu.csv');
const USER_EMAIL = 'reachrachit@gmail.com';

// ── CSV PARSER ──
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
    else { current += ch; }
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

// ── Account type from GnuCash path ──
function getAccountType(fullName) {
  if (fullName.startsWith('Assets:')) return 'Asset';
  if (fullName.startsWith('Liabilities:')) return 'Liability';
  if (fullName.startsWith('Income:')) return 'Income';
  if (fullName.startsWith('Expenses:')) return 'Expense';
  if (fullName.startsWith('Equity:')) return 'Equity';
  if (fullName === 'Imbalance-INR') return 'Equity';
  return 'Expense';
}

// ── Sub-type from GnuCash path ──
function getSubType(fullName) {
  const lower = fullName.toLowerCase();
  if (lower.includes('savings account') || lower.includes('saving')) return 'Bank Account';
  if (lower.includes('cash') && !lower.includes('zerodha')) return 'Cash';
  if (lower.includes('fix deposit') || lower.includes('fdr')) return 'Fixed Deposit';
  if (lower.includes('mutual fund') || lower.includes(' mf')) return 'Mutual Fund';
  if (lower.includes('zerodha') || lower.includes('stocks') || lower.includes('groww')) return 'Stocks';
  if (lower.includes('crypto')) return 'Crypto';
  if (lower.includes('gold') || lower.includes('silver') || lower.includes('sgb')) return 'Gold';
  if (lower.includes('epf') || lower.includes('nps') || lower.includes('ppf') || lower.includes('retiral')) return 'Retirement';
  if (lower.includes('godrej') || lower.includes('prestige') || lower.includes('jasola') || lower.includes('raheja') || lower.includes('plot')) return 'Property';
  if (lower.includes('car') || lower.includes('brezza') || lower.includes('vento')) return 'Vehicle';
  if (lower.includes('wallet') || lower.includes('paytm') || lower.includes('airtel')) return 'Wallet';
  if (lower.includes('credit card')) return 'Credit Card';
  if (lower.includes('home loan')) return 'Home Loan';
  if (lower.includes('personal loan') || lower.includes('bajaj') || lower.includes('ed loan')) return 'Loan';
  if (lower.includes('loan') && lower.includes('asset')) return 'Loan Given';
  if (lower.includes('recoverable')) return 'Receivable';
  if (lower.includes('tax credit') || lower.includes('tds')) return 'Tax Credit';
  if (lower.includes('insurance')) return 'Insurance';
  if (lower.includes('p2p') || lower.includes('grip') || lower.includes('ipv')) return 'Alternative';
  if (lower.includes('salary') || lower.includes('sal') || lower.includes('gsk') || lower.includes('bcg')) return 'Employment';
  if (lower.includes('interest')) return 'Interest';
  if (lower.includes('dividend')) return 'Dividend';
  if (lower.includes('capital gain') || lower.includes('f&o')) return 'Capital Gains';
  if (lower.includes('rent')) return 'Housing';
  if (lower.includes('electric') || lower.includes('gas') || lower.includes('phone') || lower.includes('tatasky')) return 'Utilities';
  if (lower.includes('grocery')) return 'Food';
  if (lower.includes('food')) return 'Food';
  if (lower.includes('fuel')) return 'Transport';
  if (lower.includes('medical')) return 'Health';
  if (lower.includes('travel')) return 'Travel';
  if (lower.includes('entertainment')) return 'Entertainment';
  if (lower.includes('shopping') || lower.includes('clothes')) return 'Shopping';
  if (lower.includes('education')) return 'Education';
  if (lower.includes('donation')) return 'Donation';
  if (lower.includes('maintenance')) return 'Maintenance';
  if (lower.includes('subscription')) return 'Subscription';
  if (lower.includes('tax')) return 'Tax';
  return 'Other';
}

// ── Category from BOTH debit and credit GnuCash paths ──
function deriveCategory(debitFullName, creditFullName) {
  // Priority: use the expense or income account's second-level name
  const expOrInc = debitFullName.startsWith('Expenses:') ? debitFullName
    : creditFullName.startsWith('Expenses:') ? creditFullName
    : creditFullName.startsWith('Income:') ? creditFullName
    : debitFullName.startsWith('Income:') ? debitFullName
    : null;

  if (expOrInc) {
    const parts = expOrInc.split(':');
    // Use the most specific meaningful part
    // e.g. "Expenses:Utilities:Electric" → "Electric"
    // e.g. "Income:Interest Income:Bank Interest" → "Bank Interest"
    // e.g. "Expenses:Food" → "Food"
    if (parts.length >= 3) return parts[parts.length - 1].trim();
    if (parts.length === 2) return parts[1].trim();
  }

  // For transfers (Asset↔Asset, Asset↔Liability), derive from context
  const debitType = getAccountType(debitFullName);
  const creditType = getAccountType(creditFullName);

  if (debitType === 'Asset' && creditType === 'Asset') return 'Transfer';
  if (debitType === 'Liability' && creditType === 'Asset') return 'Loan Payment';
  if (debitType === 'Asset' && creditType === 'Liability') return 'Loan Disbursement';
  if (debitType === 'Liability' && creditType === 'Liability') return 'Liability Transfer';

  return 'Uncategorized';
}

// ── Parse DD-MM-YYYY → YYYY-MM-DD ──
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
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

    // ── Get user_id ──
    console.log('\n👤 Finding user...');
    const userResult = await client.query('SELECT user_id FROM users WHERE email = $1', [USER_EMAIL]);
    if (userResult.rows.length === 0) { console.error('❌ User not found!'); return; }
    const userId = userResult.rows[0].user_id;
    console.log(`   User ID: ${userId}`);

    // ── Collect unique accounts ──
    console.log('\n🏦 Collecting accounts...');
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

    // ── Clean existing data ──
    console.log('\n🗑️  Cleaning existing data...');
    await client.query('BEGIN');
    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    console.log('   ✅ Cleaned');

    // ── Create accounts (handle duplicate short names) ──
    console.log('\n📝 Creating accounts...');
    const accountIdMap = new Map();

    const shortNameCount = new Map();
    for (const [fullName, acc] of uniqueAccounts) {
      shortNameCount.set(acc.shortName, (shortNameCount.get(acc.shortName) || 0) + 1);
    }

    for (const [fullName, acc] of uniqueAccounts) {
      let displayName = acc.shortName;
      if (shortNameCount.get(acc.shortName) > 1) {
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

    // ── Group rows by Transaction ID ──
    console.log('\n🔗 Grouping transactions...');
    const txGroups = new Map();
    rows.forEach(row => {
      const txId = row['Transaction ID'];
      if (!txId || txId === 'Transaction ID') return;
      if (!txGroups.has(txId)) txGroups.set(txId, []);
      txGroups.get(txId).push(row);
    });
    console.log(`   Found ${txGroups.size} unique transactions`);

    // ── Import transactions (handles splits properly) ──
    console.log('\n💸 Importing transactions...');
    let imported = 0, skipped = 0, errors = 0;
    let lastPercent = 0;
    const totalTx = txGroups.size;

    for (const [txId, group] of txGroups) {
      try {
        // Skip single-row zero-amount entries
        if (group.length === 1) {
          const amt = parseFloat(group[0]['Amount Num.'] || 0);
          if (amt === 0) { skipped++; continue; }
        }

        // Separate into positive (debit) and negative (credit) entries
        const positives = []; // accounts where money flows IN (amount > 0)
        const negatives = []; // accounts where money flows OUT (amount < 0)

        for (const row of group) {
          const amt = parseFloat(row['Amount Num.'] || 0);
          if (amt > 0) positives.push({ row, amount: amt });
          else if (amt < 0) negatives.push({ row, amount: Math.abs(amt) });
        }

        if (positives.length === 0 || negatives.length === 0) {
          skipped++;
          continue;
        }

        const date = parseDate(group[0]['Date']);
        if (!date) { skipped++; continue; }
        const description = (group[0]['Description'] || '').substring(0, 500);
        const memo = (group[0]['Memo'] || '').substring(0, 500);
        const refNumber = (group[0]['Number'] || '').substring(0, 100);

        // ── Handle different split scenarios ──
        
        if (positives.length === 1 && negatives.length === 1) {
          // Simple 2-way transaction
          const debitAccName = positives[0].row['Full Account Name'];
          const creditAccName = negatives[0].row['Full Account Name'];
          const debitAccId = accountIdMap.get(debitAccName);
          const creditAccId = accountIdMap.get(creditAccName);

          if (!debitAccId || !creditAccId || debitAccId === creditAccId) { skipped++; continue; }

          const category = deriveCategory(debitAccName, creditAccName);

          await client.query(
            `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, reference_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [userId, date, positives[0].amount, description, memo, debitAccId, creditAccId, category, refNumber || null]
          );
          imported++;

        } else if (negatives.length === 1 && positives.length > 1) {
          // One source, multiple destinations (e.g., salary split, settlement)
          const creditAccName = negatives[0].row['Full Account Name'];
          const creditAccId = accountIdMap.get(creditAccName);
          if (!creditAccId) { skipped++; continue; }

          for (const pos of positives) {
            const debitAccName = pos.row['Full Account Name'];
            const debitAccId = accountIdMap.get(debitAccName);
            if (!debitAccId || debitAccId === creditAccId) continue;

            const category = deriveCategory(debitAccName, creditAccName);
            await client.query(
              `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, reference_number)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [userId, date, pos.amount, description, memo || pos.row['Memo'] || '', debitAccId, creditAccId, category, refNumber || null]
            );
            imported++;
          }

        } else if (positives.length === 1 && negatives.length > 1) {
          // Multiple sources, one destination (e.g., consolidation)
          const debitAccName = positives[0].row['Full Account Name'];
          const debitAccId = accountIdMap.get(debitAccName);
          if (!debitAccId) { skipped++; continue; }

          for (const neg of negatives) {
            const creditAccName = neg.row['Full Account Name'];
            const creditAccId = accountIdMap.get(creditAccName);
            if (!creditAccId || creditAccId === debitAccId) continue;

            const category = deriveCategory(debitAccName, creditAccName);
            await client.query(
              `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, reference_number)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [userId, date, neg.amount, description, memo || neg.row['Memo'] || '', debitAccId, creditAccId, category, refNumber || null]
            );
            imported++;
          }

        } else {
          // Complex split: multiple sources AND destinations
          // Pair each positive with each negative proportionally
          const totalNeg = negatives.reduce((s, n) => s + n.amount, 0);

          for (const pos of positives) {
            for (const neg of negatives) {
              const debitAccName = pos.row['Full Account Name'];
              const creditAccName = neg.row['Full Account Name'];
              const debitAccId = accountIdMap.get(debitAccName);
              const creditAccId = accountIdMap.get(creditAccName);
              if (!debitAccId || !creditAccId || debitAccId === creditAccId) continue;

              // Proportional amount: this negative's share of this positive
              const proportion = neg.amount / totalNeg;
              const amount = Math.round(pos.amount * proportion * 100) / 100;
              if (amount <= 0) continue;

              const category = deriveCategory(debitAccName, creditAccName);
              await client.query(
                `INSERT INTO transactions (user_id, date, amount, description, narration, debit_account_id, credit_account_id, category, reference_number)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [userId, date, amount, description, memo, debitAccId, creditAccId, category, refNumber || null]
              );
              imported++;
            }
          }
        }

        // Progress
        const done = imported + skipped + errors;
        const percent = Math.floor(done / totalTx * 100);
        if (percent >= lastPercent + 10) {
          console.log(`   ... ${percent}% (${imported} imported, ${skipped} skipped)`);
          lastPercent = percent;
        }
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`   ⚠️ Error tx ${txId}: ${err.message}`);
      }
    }

    // ── Recalculate balances ──
    console.log('\n📊 Recalculating balances...');
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
    console.log('✅ IMPORT v2 COMPLETE!');
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
