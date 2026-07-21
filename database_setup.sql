-- ===============================================================
-- DPQSL PRODUCTION TRACKER — DATABASE SETUP (Shakil's real schema,
-- cleaned into one ordered script for a FRESH database like Neon)
-- Run once:  psql "<your DATABASE_URL>" -f database_setup.sql
-- Or paste this whole file into Neon's SQL Editor and run.
-- ===============================================================

CREATE TABLE IF NOT EXISTS operators (
    id SERIAL PRIMARY KEY,
    office_id INT UNIQUE NOT NULL,
    operator_name VARCHAR(100) NOT NULL,
    department VARCHAR(50) NOT NULL,
    section VARCHAR(50) NOT NULL,
    line_name VARCHAR(50) NOT NULL,
    join_date DATE NOT NULL,
    designation VARCHAR(100) NOT NULL,
    phone_no VARCHAR(15),
    status VARCHAR(20) DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS sam_records (
    id SERIAL PRIMARY KEY,
    style_name VARCHAR(100) NOT NULL,
    process_name VARCHAR(100) NOT NULL,
    sam_value NUMERIC(5,2) NOT NULL,
    ie_eff_pct NUMERIC(5,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operator_assignments (
    id SERIAL PRIMARY KEY,
    line_name VARCHAR(50) NOT NULL,
    office_id INT NOT NULL,
    operator_name VARCHAR(100) NOT NULL,
    style_name VARCHAR(100) NOT NULL,
    process_name VARCHAR(100) NOT NULL,
    ie_eff_pct NUMERIC(5,2) NOT NULL,
    hourly_target INT NOT NULL,
    sam_value NUMERIC(5,2) NOT NULL, -- রেট হিসাব করার জন্য ব্যাকএন্ডেও রাখা হলো
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- production_records — final shape, with active_hours/total_defect/downtime_minute
-- already included (no separate ALTER steps needed on a fresh database)
CREATE TABLE IF NOT EXISTS production_records (
    id SERIAL PRIMARY KEY,
    production_date DATE NOT NULL,
    line_name VARCHAR(50) NOT NULL,
    office_id INT NOT NULL,
    hourly_target INT NOT NULL,
    h1 INT DEFAULT 0,  -- 08-09
    h2 INT DEFAULT 0,  -- 09-10
    h3 INT DEFAULT 0,  -- 10-11
    h4 INT DEFAULT 0,  -- 11-12
    h5 INT DEFAULT 0,  -- 12-01
    h6 INT DEFAULT 0,  -- 02-03
    h7 INT DEFAULT 0,  -- 03-04
    h8 INT DEFAULT 0,  -- 04-05
    h9 INT DEFAULT 0,  -- 05-06
    h10 INT DEFAULT 0, -- 06-07
    total_prod INT DEFAULT 0,
    total_defect INT DEFAULT 0,
    downtime_minute INT DEFAULT 0,
    active_hours INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_prod_entry UNIQUE (production_date, line_name, office_id)
);

-- ============================================================
-- AUTH & RBAC
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    username       VARCHAR(50) UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    full_name      VARCHAR(100) NOT NULL,
    role           VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR')),
    created_at     TIMESTAMP DEFAULT NOW()
);

-- Default users (passwords already bcrypt-hashed, 10 salt rounds)
-- ------------------------------------------------------------------
--  username     | plain password  | role
-- ------------------------------------------------------------------
--  admin        | Admin@123       | ADMIN
--  ie_planner   | IePlan@123      | IE_PLANNING
--  line_super   | LineSup@123     | LINE_SUPERVISOR
-- ------------------------------------------------------------------
-- ⚠️ Change these passwords after first login in production.
INSERT INTO users (username, password_hash, full_name, role) VALUES
('admin',      '$2b$10$z/ifMr//PyE.kNCoNnZqruRaalU9Usj5.25GyVYObwIqt9P4gKZgi', 'System Administrator', 'ADMIN'),
('ie_planner', '$2b$10$BKBgzq7ewJRLtfmGabK4OONPzIhi/n16kBm68uMUzWZi4JnQc8H7C', 'IE Planning Officer',  'IE_PLANNING'),
('line_super', '$2b$10$jq7H/UFQQ/71rUcgaCAwkOctwbuPNR2JeZtU.XXEnieZL4jr5olpy', 'Line Supervisor',      'LINE_SUPERVISOR')
ON CONFLICT (username) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Helpful indexes for the joins/filters the app runs often
CREATE INDEX IF NOT EXISTS idx_prod_records_lookup ON production_records (production_date, line_name, office_id);
CREATE INDEX IF NOT EXISTS idx_assignments_lookup ON operator_assignments (office_id, line_name);
