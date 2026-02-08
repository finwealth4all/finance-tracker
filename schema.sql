-- ===================================
-- FINANCE TRACKER - DATABASE SCHEMA
-- PostgreSQL - Run this once on first setup
-- ===================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===== USERS TABLE =====
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    country_code VARCHAR(3) DEFAULT 'IN',
    currency VARCHAR(3) DEFAULT 'INR',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

-- ===== ACCOUNTS (Chart of Accounts) =====
CREATE TABLE IF NOT EXISTS accounts (
    account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    account_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL CHECK (account_type IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
    sub_type VARCHAR(100),
    description TEXT,
    current_balance DECIMAL(15,2) DEFAULT 0,
    currency VARCHAR(3) DEFAULT 'INR',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, account_name)
);

-- ===== TRANSACTIONS (Double-Entry Bookkeeping) =====
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    date DATE NOT NULL,
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    description TEXT,
    narration TEXT,
    debit_account_id UUID NOT NULL REFERENCES accounts(account_id),
    credit_account_id UUID NOT NULL REFERENCES accounts(account_id),
    category VARCHAR(100) DEFAULT 'Uncategorized',
    tax_category VARCHAR(100),
    reference_number VARCHAR(100),
    is_reconciled BOOLEAN DEFAULT false,
    source VARCHAR(50) DEFAULT 'manual',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (debit_account_id != credit_account_id)
);

-- ===== INDEXES FOR PERFORMANCE =====
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(user_id, category);
CREATE INDEX IF NOT EXISTS idx_transactions_debit ON transactions(debit_account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_credit ON transactions(credit_account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tax ON transactions(user_id, tax_category) WHERE tax_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_reconciled ON transactions(user_id, is_reconciled) WHERE is_reconciled = false;
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(user_id, account_type);

-- ===== BUDGETS TABLE (for future AI budgeting) =====
CREATE TABLE IF NOT EXISTS budgets (
    budget_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    monthly_limit DECIMAL(15,2) NOT NULL,
    financial_year VARCHAR(7),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, category, financial_year)
);

-- ===== TAGS TABLE (for flexible categorization) =====
CREATE TABLE IF NOT EXISTS tags (
    tag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    tag_name VARCHAR(100) NOT NULL,
    UNIQUE(user_id, tag_name)
);

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id UUID REFERENCES transactions(transaction_id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

-- ===== FIRE GOALS TABLE =====
CREATE TABLE IF NOT EXISTS fire_goals (
    goal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    current_age INTEGER,
    target_retirement_age INTEGER,
    expected_annual_return DECIMAL(5,4) DEFAULT 0.12,
    withdrawal_rate DECIMAL(5,4) DEFAULT 0.04,
    inflation_rate DECIMAL(5,4) DEFAULT 0.06,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== DONE =====
-- Schema ready for Finance Tracker v2.0
