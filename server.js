require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 5000;

const JWT_SECRET = process.env.JWT_SECRET || 'dpqsl_super_secret_change_this_in_production';
const JWT_EXPIRES_IN = '8h';

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(__dirname));

const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      })
    : new Pool({
        user: 'postgres',
        host: 'localhost',
        database: 'dpqsl_garments',
        password: '1234',
        port: 5432,
      });

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function uploadBufferToCloudinary(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { public_id: publicId, folder: 'dpqsl_operators', overwrite: true, invalidate: true, resource_type: 'image', format: 'jpg' },
            (error, result) => { if (error) return reject(error); resolve(result); }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
}

function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token. Please log in again.' });
        req.user = decoded;
        next();
    });
}

function authorizeRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied. You do not have permission to perform this action.' });
        }
        next();
    };
}

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        const payload = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, message: 'Login successful!', token, user: payload });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/me', verifyToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.get('/api/public/config', (req, res) => {
    res.json({ success: true, cloudName: process.env.CLOUDINARY_CLOUD_NAME || '' });
});

app.post('/api/upload-photo', verifyToken, authorizeRoles('ADMIN'), upload.single('photo'), async (req, res) => {
    try {
        const { office_id } = req.body;
        if (!office_id) return res.status(400).json({ success: false, message: 'office_id is required.' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No photo file received.' });
        const result = await uploadBufferToCloudinary(req.file.buffer, String(office_id));
        res.json({ success: true, message: 'Photo uploaded successfully!', url: result.secure_url });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/operators', verifyToken, authorizeRoles('ADMIN'), async (req, res) => {
    const { office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status } = req.body;
    try {
        const checkDuplicate = await pool.query('SELECT * FROM operators WHERE office_id = $1', [office_id]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: 'This Office ID already exists!' });
        const result = await pool.query(
            `INSERT INTO operators (office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status || 'Active']
        );
        res.json({ success: true, message: 'Operator saved successfully!', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/operators', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        const queryText = `
            SELECT 
                o.id, o.office_id, o.operator_name, o.department, o.section, o.line_name, o.join_date, o.designation, o.phone_no, o.status,
                COALESCE(
                    (
                        SELECT 
                            CASE 
                                WHEN SUM((pr.active_hours * 60) - pr.downtime_minute) > 0 
                                THEN (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100
                                ELSE 0 
                            END
                        FROM production_records pr
                        LEFT JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
                        WHERE pr.office_id = o.office_id
                    ), 0
                ) AS avg_efficiency
            FROM operators o 
            ORDER BY o.id DESC
        `;
        const result = await pool.query(queryText);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/operators/:id', verifyToken, authorizeRoles('ADMIN'), async (req, res) => {
    const { id } = req.params;
    const { office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status } = req.body;
    try {
        const checkDuplicate = await pool.query('SELECT * FROM operators WHERE office_id = $1 AND id != $2', [office_id, id]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: 'This Office ID already belongs to another operator!' });
        await pool.query(
            `UPDATE operators SET office_id=$1, operator_name=$2, department=$3, section=$4, line_name=$5, join_date=$6, designation=$7, phone_no=$8, status=$9 
             WHERE id=$10`,
            [office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status, id]
        );
        res.json({ success: true, message: 'Operator info updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/operators/:id', verifyToken, authorizeRoles('ADMIN'), async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM operators WHERE id = $1', [id]);
        res.json({ success: true, message: 'Operator deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 📊 BULK OPERATOR UPLOAD (Excel) — ADMIN only
// Flexible: auto-detects the header row (even if it's not row 1) and matches
// common column-name variants — works with a plain template OR a real HR
// export like "Office ID No / Employee Name / Sub Section / DOJ / MobileNumber".
// Existing office_id rows are SKIPPED (never overwritten) — only brand-new office_ids get inserted.
// ==========================================
const BULK_HEADER_PATTERNS = {
    office_id:     /office\s*id/i,
    operator_name: /employee\s*name|operator\s*name/i,
    department:    /^department$/i,
    section:       /^section$/i,
    line_name:     /sub\s*section|line\s*name|^line$/i,
    join_date:     /^doj$|join.*date/i,
    designation:   /designation/i,
    phone_no:      /mobile|phone/i,
    status:        /^status$/i
};

app.post('/api/operators/bulk-upload', verifyToken, authorizeRoles('ADMIN'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No Excel file received.' });

        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });

        // Scan the first few rows to find the real header row (handles a blank row-1, etc.)
        let headerRowIndex = -1;
        let colMap = {};
        for (let r = 0; r < Math.min(raw.length, 10); r++) {
            const row = raw[r];
            const tempMap = {};
            row.forEach((cell, colIdx) => {
                const cellStr = String(cell || '').trim();
                for (const [field, pattern] of Object.entries(BULK_HEADER_PATTERNS)) {
                    if (pattern.test(cellStr)) tempMap[field] = colIdx;
                }
            });
            if (tempMap.office_id !== undefined && tempMap.operator_name !== undefined) {
                headerRowIndex = r;
                colMap = tempMap;
                break;
            }
        }

        if (headerRowIndex === -1) {
            return res.status(400).json({ success: false, message: 'Could not find a header row with an Office ID and Name column. Check your file headers.' });
        }

        const get = (row, field) => (colMap[field] !== undefined ? row[colMap[field]] : undefined);

        let added = 0, skipped = 0;
        const errors = [];

        for (let r = headerRowIndex + 1; r < raw.length; r++) {
            const row = raw[r];
            if (!row || row.length === 0) continue;
            const rowNum = r + 1;

            const office_id = parseInt(get(row, 'office_id'));
            if (!office_id) continue; // blank/footer row — skip silently

            const exists = await pool.query('SELECT id FROM operators WHERE office_id = $1', [office_id]);
            if (exists.rows.length > 0) { skipped++; continue; } // already exists — never overwritten by bulk upload

            const operator_name = String(get(row, 'operator_name') || '').trim();
            const department = String(get(row, 'department') || '').trim();
            const section = String(get(row, 'section') || '').trim();
            const line_name = String(get(row, 'line_name') || '').trim() || section || 'N/A';
            const designation = String(get(row, 'designation') || '').trim();
            const status = String(get(row, 'status') || 'Active').trim() || 'Active';

            // Phone numbers: Excel often strips the leading 0 from BD numbers stored as a number
            let phone_no = get(row, 'phone_no');
            if (typeof phone_no === 'number') {
                phone_no = String(phone_no);
                if (phone_no.length === 10) phone_no = '0' + phone_no;
            } else {
                phone_no = String(phone_no || '').trim();
            }

            // Join date: could be a JS Date, an Excel serial number, or a plain string
            let join_date = get(row, 'join_date');
            if (join_date instanceof Date) {
                join_date = join_date.toISOString().split('T')[0];
            } else if (typeof join_date === 'number') {
                const d = XLSX.SSF.parse_date_code(join_date);
                join_date = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
            } else {
                join_date = String(join_date || '').trim();
            }

            if (!operator_name || !department || !section || !join_date || !designation) {
                errors.push(`Row ${rowNum} (Office ID ${office_id}): missing a required field — skipped.`);
                continue;
            }

            await pool.query(
                `INSERT INTO operators (office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [office_id, operator_name, department, section, line_name, join_date, designation, phone_no, status]
            );
            added++;
        }

        res.json({
            success: true,
            message: `Upload complete — ${added} new operator(s) added, ${skipped} already existed and were skipped.${errors.length ? ` (${errors.length} row(s) had issues.)` : ''}`,
            added, skipped, errors
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 🧵 OPERATION BREAKDOWN MODULE (replaces the old SAM Update)
// One "breakdown sheet" = one header (Buyer/Style/Item/Size) + many operation rows.
// Access: ADMIN (full) | IE_PLANNING (full) | LINE_SUPERVISOR (no access)
// ==========================================

// Fixed reference lists (from your factory's SELECTION_ITEM master) — always offered
// as suggestions, on top of any custom values already typed in before.
const DEFAULT_MACHINE_NAMES = ['CYCLE','SNLS','EC','CUFFS','DNLS','2THOL','3THOL','4THOL','5THOL','6THOL','FL3TH','FL5TH','FOA','SNCS','2NCS','KANSAI','ZIG-ZAG','PIC','PICOTIN','SADDLE STT MACHINE','BLIND STITCH','BRTK','EYELET HOLE','BUTTON HOLE','QQ HOLE','BUTTON ATTACH 2 HOLE','BUTTON ATTACH 4 HOLE','WRAPPING MC','REFF. BTTN','HAND WORK'];
const DEFAULT_GAUGE_GUIDES = ['ATTACHMENT','ANGULAR','1 CM FOLDER','1.5 CM FOLDER','2 CM FOLDER','2.5 CM FOLDER','3 CM FOLDER','3.5 CM FOLDER','4 CM FOLDER','4.5 CM FOLDER','5 CM FOLDER','5.5 CM FOLDER','6 CM FOLDER','6.5 CM FOLDER','7 CM FOLDER','7.5 CM FOLDER','8 CM FOLDER','FLYING GAGE','GAGE'];

// Suggestion list for the Machine Name / Gauge Guide inputs — merges the fixed
// factory list with any custom values that have been typed and saved before.
app.get('/api/machine-gauge-options', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        const machinesUsed = await pool.query('SELECT DISTINCT machine_name FROM operation_breakdown_items WHERE machine_name IS NOT NULL AND machine_name != \'\'');
        const guidesUsed = await pool.query('SELECT DISTINCT gauge_guide FROM operation_breakdown_items WHERE gauge_guide IS NOT NULL AND gauge_guide != \'\'');
        const machines = Array.from(new Set([...DEFAULT_MACHINE_NAMES, ...machinesUsed.rows.map(r => r.machine_name)])).sort();
        const guides = Array.from(new Set([...DEFAULT_GAUGE_GUIDES, ...guidesUsed.rows.map(r => r.gauge_guide)])).sort();
        res.json({ success: true, machines, guides });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// List all breakdown sheets (summary only — for the master list view)
app.get('/api/operation-breakdowns', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ob.id, ob.buyer_name, ob.style_name, ob.item, ob.size, ob.created_at,
                   COUNT(obi.id) AS operation_count,
                   COALESCE(SUM(obi.smv), 0) AS total_smv
            FROM operation_breakdowns ob
            LEFT JOIN operation_breakdown_items obi ON obi.breakdown_id = ob.id
            GROUP BY ob.id
            ORDER BY ob.id DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get one full sheet (header + all operation rows) — used to load the Edit form, and to
// populate the Style/Operation dropdowns on the Assign Operator page.
app.get('/api/operation-breakdowns/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    try {
        const header = await pool.query('SELECT * FROM operation_breakdowns WHERE id = $1', [req.params.id]);
        if (header.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found.' });
        const items = await pool.query('SELECT * FROM operation_breakdown_items WHERE breakdown_id = $1 ORDER BY sl_no ASC', [req.params.id]);
        res.json({ success: true, data: { ...header.rows[0], items: items.rows } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Create a new breakdown sheet — header + all operation rows in one transaction
app.post('/api/operation-breakdowns', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { buyer_name, style_name, item, size, items } = req.body;
    const client = await pool.connect();
    try {
        if (!style_name || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Style name and at least one operation row are required.' });
        }
        await client.query('BEGIN');

        const headerResult = await client.query(
            `INSERT INTO operation_breakdowns (buyer_name, style_name, item, size) VALUES ($1, $2, $3, $4) RETURNING id`,
            [buyer_name || null, style_name, item || null, size || null]
        );
        const breakdownId = headerResult.rows[0].id;

        for (let i = 0; i < items.length; i++) {
            const row = items[i];
            await client.query(
                `INSERT INTO operation_breakdown_items (breakdown_id, sl_no, machine_name, gauge_guide, operation_name, frequency, smv)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [breakdownId, i + 1, row.machine_name || null, row.gauge_guide || null, row.operation_name, row.frequency || null, row.smv]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Operation breakdown saved successfully!', id: breakdownId });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'A breakdown sheet for this Style + Size already exists — edit that one instead.' });
        }
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// Update an existing sheet — replaces the header AND all operation rows (delete + re-insert)
app.put('/api/operation-breakdowns/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { id } = req.params;
    const { buyer_name, style_name, item, size, items } = req.body;
    const client = await pool.connect();
    try {
        if (!style_name || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Style name and at least one operation row are required.' });
        }
        await client.query('BEGIN');

        await client.query(
            `UPDATE operation_breakdowns SET buyer_name=$1, style_name=$2, item=$3, size=$4, updated_at=NOW() WHERE id=$5`,
            [buyer_name || null, style_name, item || null, size || null, id]
        );

        await client.query('DELETE FROM operation_breakdown_items WHERE breakdown_id = $1', [id]);

        for (let i = 0; i < items.length; i++) {
            const row = items[i];
            await client.query(
                `INSERT INTO operation_breakdown_items (breakdown_id, sl_no, machine_name, gauge_guide, operation_name, frequency, smv)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, i + 1, row.machine_name || null, row.gauge_guide || null, row.operation_name, row.frequency || null, row.smv]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Operation breakdown updated successfully!' });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ success: false, message: 'Another breakdown sheet already uses this Style + Size.' });
        }
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/operation-breakdowns/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        await pool.query('DELETE FROM operation_breakdowns WHERE id = $1', [req.params.id]); // items cascade-delete automatically
        res.json({ success: true, message: 'Breakdown sheet deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// ⏱️ CYCLE TIME STUDY — shared calculation helper
// Given a list of operator_assignments rows (already filtered to one Line, or one Line+Style),
// computes per-row: avg cycle time, tact time, capacity, and "Number of Avg" (the average
// divided by however many OTHER operators on the same Line+Style are doing the identical
// Operation — so two people sharing one operation each carry half the tact-time weight).
// ==========================================
// Reusable SQL fragment: capacity (pcs/hr) computed from a joined "oa" (operator_assignments)
// row's 5 stopwatch readings + a fixed allowance (seconds):
//   Standard Time = average of whichever cycle readings were filled in + allowance_time
//   Theoretical Capacity = 3600 / Standard Time
//   Capacity (Target)    = Theoretical Capacity × (Plan Efficiency % / 100)
// Used everywhere efficiency is calculated, so Capacity (not the old SAM/Target) drives it.
// NOTE: this references oa.allowance_time — run the allowance_time migration BEFORE deploying.
const CAPACITY_SQL = `((3600 / NULLIF((SELECT AVG(v) FROM unnest(ARRAY[oa.cycle_time_1, oa.cycle_time_2, oa.cycle_time_3, oa.cycle_time_4, oa.cycle_time_5]) AS v WHERE v > 0) + COALESCE(oa.allowance_time, 0), 0)) * (COALESCE(oa.ie_eff_pct, 100) / 100.0))`;
// Capacity is constant per operator+line+style group, but inside a GROUP BY query Postgres still
// needs every non-aggregated expression wrapped in an aggregate — MAX() here doesn't change the
// value (it's the same for every row in the group), it just satisfies that requirement.
const CAPACITY_SQL_AGG = `MAX(${CAPACITY_SQL})`;

function attachCycleTimeCalcs(rows) {
    // Count how many rows share the same (line_name, style_name, operation_name) combo
    const operationCounts = {};
    rows.forEach(r => {
        const key = `${r.line_name}|${r.style_name}|${r.operation_name}`;
        operationCounts[key] = (operationCounts[key] || 0) + 1;
    });

    return rows.map(r => {
        const readings = [r.cycle_time_1, r.cycle_time_2, r.cycle_time_3, r.cycle_time_4, r.cycle_time_5]
            .map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);

        const avg = readings.length > 0 ? readings.reduce((a, b) => a + b, 0) / readings.length : 0;
        const allowance = parseFloat(r.allowance_time) || 0;
        const stdTime = avg > 0 ? avg + allowance : 0;        // Standard Time per piece (sec) = avg cycle + allowance
        const tactTime = stdTime / 60;                         // per-piece standard minute (allowance included)
        const planEffPct = parseFloat(r.ie_eff_pct);
        const theoreticalCapacity = stdTime > 0 ? 3600 / stdTime : 0;
        const capacity = theoreticalCapacity * ((isNaN(planEffPct) ? 100 : planEffPct) / 100); // hourly capacity/target = theoretical capacity × Plan Efficiency %

        const key = `${r.line_name}|${r.style_name}|${r.operation_name}`;
        const sharedCount = operationCounts[key] || 1;
        const numberOfAvg = stdTime / sharedCount;
        const avgTactTime = numberOfAvg / 60;

        return { ...r, cycle_avg: round2(avg), allowance_time: round2(allowance), std_time: round2(stdTime), tact_time: round2(tactTime), capacity: round2(capacity), number_of_avg: round2(numberOfAvg), avg_tact_time: round4(avgTactTime) };
    });
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }
function round4(n) { return Math.round((n || 0) * 10000) / 10000; }

// Hourly capacity/target from a set of stopwatch readings + fixed allowance (seconds), scaled
// by Plan Efficiency %:
//   Theoretical Capacity (pcs/hr) = 3600 / (average of the filled-in cycle readings + allowance)
//   Capacity / Target (pcs/hr)    = Theoretical Capacity × (Plan Efficiency % / 100)
// Returns a whole number (0 if no readings yet). Stored as the assignment's hourly_target,
// so Target always equals Capacity — no separate SAM-based target anymore.
function computeCapacityFromCycles(c1, c2, c3, c4, c5, allowance, ieEffPct) {
    const readings = [c1, c2, c3, c4, c5].map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
    if (readings.length === 0) return 0;
    const avg = readings.reduce((a, b) => a + b, 0) / readings.length;
    const std = avg + (parseFloat(allowance) || 0);
    const theoreticalCapacity = std > 0 ? 3600 / std : 0;
    const effPct = parseFloat(ieEffPct);
    return Math.round(theoreticalCapacity * ((isNaN(effPct) ? 100 : effPct) / 100));
}

app.post('/api/assignments', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { line_name, office_id, operator_name, designation, style_name, operation_name, machine_name, ie_eff_pct, sam_value, allowance_time, cycle_time_1, cycle_time_2, cycle_time_3, cycle_time_4, cycle_time_5 } = req.body;
    try {
        const checkDuplicate = await pool.query('SELECT * FROM operator_assignments WHERE office_id = $1 AND line_name = $2', [office_id, line_name]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: 'Operator already assigned!' });
        // Hourly Target is driven by the cycle-time capacity × Plan Efficiency % — computed here so it always matches Capacity.
        const hourly_target = computeCapacityFromCycles(cycle_time_1, cycle_time_2, cycle_time_3, cycle_time_4, cycle_time_5, allowance_time, ie_eff_pct);
        const result = await pool.query(
            `INSERT INTO operator_assignments (line_name, office_id, operator_name, designation, style_name, operation_name, machine_name, ie_eff_pct, hourly_target, sam_value, allowance_time, cycle_time_1, cycle_time_2, cycle_time_3, cycle_time_4, cycle_time_5)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
            [line_name, office_id, operator_name, designation, style_name, operation_name, machine_name, ie_eff_pct, hourly_target, sam_value, allowance_time || 0, cycle_time_1 || null, cycle_time_2 || null, cycle_time_3 || null, cycle_time_4 || null, cycle_time_5 || null]
        );
        res.json({ success: true, message: 'Operator assigned successfully!', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/assignments', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    try {
        // ASC (insertion order) so SL numbering stays stable — the first operator
        // ever assigned always stays at SL 1, new ones just get added below.
        // Optional ?line=Line-06 filter — used by Daily Production Update so it only
        // fetches that one line's operators instead of the whole factory every time.
        const { line } = req.query;
        const result = line
            ? await pool.query('SELECT * FROM operator_assignments WHERE line_name = $1 ORDER BY id ASC', [line])
            : await pool.query('SELECT * FROM operator_assignments ORDER BY id ASC');
        res.json({ success: true, data: attachCycleTimeCalcs(result.rows) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/assignments/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { id } = req.params;
    const { line_name, office_id, operator_name, designation, style_name, operation_name, machine_name, ie_eff_pct, sam_value, allowance_time, cycle_time_1, cycle_time_2, cycle_time_3, cycle_time_4, cycle_time_5 } = req.body;
    try {
        // Recompute Hourly Target from the (possibly edited) cycle readings + allowance + Plan Efficiency %, so it stays = Capacity.
        const hourly_target = computeCapacityFromCycles(cycle_time_1, cycle_time_2, cycle_time_3, cycle_time_4, cycle_time_5, allowance_time, ie_eff_pct);
        await pool.query(
            `UPDATE operator_assignments SET line_name=$1, office_id=$2, operator_name=$3, designation=$4, style_name=$5, operation_name=$6, machine_name=$7, ie_eff_pct=$8, hourly_target=$9, sam_value=$10, allowance_time=$11,
             cycle_time_1=$12, cycle_time_2=$13, cycle_time_3=$14, cycle_time_4=$15, cycle_time_5=$16
             WHERE id=$17`,
            [line_name, office_id, operator_name, designation, style_name, operation_name, machine_name, ie_eff_pct, hourly_target, sam_value, allowance_time || 0, cycle_time_1 || null, cycle_time_2 || null, cycle_time_3 || null, cycle_time_4 || null, cycle_time_5 || null, id]
        );
        res.json({ success: true, message: 'Assignment updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/assignments/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        await pool.query('DELETE FROM operator_assignments WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Assignment removed successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// 📐 LINE STUDY (Cycle Time Study / Line Balancing Summary)
// One header per Line + Style, combining: auto-calculated values (from the
// operators' stopwatch readings) + manually-entered planning fields.
// ==========================================
app.get('/api/line-study', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { line, style } = req.query;
    if (!line || !style) return res.status(400).json({ success: false, message: 'line and style query params are required.' });
    try {
        const assignRows = await pool.query('SELECT * FROM operator_assignments WHERE line_name = $1 AND style_name = $2 ORDER BY id ASC', [line, style]);
        const operators = attachCycleTimeCalcs(assignRows.rows);

        const headerResult = await pool.query('SELECT * FROM line_study_headers WHERE line_name = $1 AND style_name = $2', [line, style]);
        const header = headerResult.rows[0] || {
            line_name: line, style_name: style, order_qty: null, allocated_qty: null,
            input_date: null, output_date: null, graph_type: null, tgt_hour: null, per_hour_tgt: null,
            current_pcs: null, acvd_effi: null, dhu: null, observer_officer: null
        };

        // Buyer + SMV are pulled automatically from the matching Operation Breakdown sheet, if one exists
        const breakdownResult = await pool.query('SELECT buyer_name, id FROM operation_breakdowns WHERE style_name = $1 LIMIT 1', [style]);
        let buyerName = null, totalSmv = 0;
        if (breakdownResult.rows.length > 0) {
            buyerName = breakdownResult.rows[0].buyer_name;
            const smvResult = await pool.query('SELECT COALESCE(SUM(smv),0) AS total FROM operation_breakdown_items WHERE breakdown_id = $1', [breakdownResult.rows[0].id]);
            totalSmv = parseFloat(smvResult.rows[0].total) || 0;
        }

        // ---- Auto-calculated summary values ----
        const noOfWorker = operators.length;
        const tactTime = operators.reduce((sum, op) => sum + (op.avg_tact_time || 0), 0);
        const bpt = noOfWorker > 0 ? (tactTime / noOfWorker) * 60 : 0;
        const workerPotentialPcsHr = bpt > 0 ? 3600 / bpt : 0;
        const tgtHour = parseFloat(header.tgt_hour) || 0;
        const workerPotentialPcs08hr = workerPotentialPcsHr * tgtHour;
        const hpt = bpt * 1.05;
        const lpt = bpt > 0 ? bpt / 1.05 : 0;
        const perHourTgt = parseFloat(header.per_hour_tgt) || 0;
        const perProcessNeed = perHourTgt > 0 ? 3600 / perHourTgt : 0;
        const currentPcs = parseFloat(header.current_pcs) || 0;
        const workerPerfPct = workerPotentialPcsHr > 0 ? (currentPcs / workerPotentialPcsHr) * 100 : 0;
        const productivityGapPct = workerPotentialPcsHr > 0 ? ((workerPotentialPcsHr - currentPcs) / workerPotentialPcsHr) * 100 : 0;

        res.json({
            success: true,
            data: {
                line_name: line, style_name: style,
                buyer_name: buyerName, smv: round2(totalSmv),
                no_of_worker: noOfWorker,
                order_qty: header.order_qty, allocated_qty: header.allocated_qty,
                input_date: header.input_date, output_date: header.output_date, graph_type: header.graph_type,
                tgt_hour: header.tgt_hour, per_hour_tgt: header.per_hour_tgt, current_pcs: header.current_pcs,
                acvd_effi: header.acvd_effi, dhu: header.dhu, observer_officer: header.observer_officer,
                tact_time: round4(tactTime), bpt: round2(bpt),
                worker_potential_pcs_hr: round2(workerPotentialPcsHr), worker_potential_pcs_08hr: round2(workerPotentialPcs08hr),
                hpt: round2(hpt), lpt: round2(lpt), per_process_need: round2(perProcessNeed),
                worker_perf_pct: round2(workerPerfPct), productivity_gap_pct: round2(productivityGapPct),
                operators
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Upsert the manually-entered header fields for one Line + Style
app.put('/api/line-study', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { line, style } = req.query;
    if (!line || !style) return res.status(400).json({ success: false, message: 'line and style query params are required.' });
    const { order_qty, allocated_qty, input_date, output_date, graph_type, tgt_hour, per_hour_tgt, current_pcs, acvd_effi, dhu, observer_officer } = req.body;
    try {
        await pool.query(
            `INSERT INTO line_study_headers (line_name, style_name, order_qty, allocated_qty, input_date, output_date, graph_type, tgt_hour, per_hour_tgt, current_pcs, acvd_effi, dhu, observer_officer, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
             ON CONFLICT (line_name, style_name) DO UPDATE SET
                order_qty=$3, allocated_qty=$4, input_date=$5, output_date=$6, graph_type=$7,
                tgt_hour=$8, per_hour_tgt=$9, current_pcs=$10, acvd_effi=$11, dhu=$12, observer_officer=$13, updated_at=NOW()`,
            [line, style, order_qty || null, allocated_qty || null, input_date || null, output_date || null,
             graph_type || null, tgt_hour || null, per_hour_tgt || null, current_pcs || null, acvd_effi || null, dhu || null, observer_officer || null]
        );
        res.json({ success: true, message: 'Line study header saved successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/production-records', verifyToken, authorizeRoles('ADMIN', 'LINE_SUPERVISOR'), async (req, res) => {
    const { production_date, line_name, records } = req.body;
    try {
        if (!production_date || !line_name || !records || records.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid payload.' });
        }
        for (const rec of records) {
            const check = await pool.query(
                `SELECT id FROM production_records WHERE production_date = $1 AND line_name = $2 AND office_id = $3`,
                [production_date, line_name, rec.office_id]
            );
            if (check.rows.length > 0) {
                await pool.query(
                    `UPDATE production_records 
                     SET hourly_target=$1, h1=$2, h2=$3, h3=$4, h4=$5, h5=$6, h7=$7, h8=$8, h9=$9, h10=$10, 
                         total_prod=$11, total_defect=$12, downtime_minute=$13, active_hours=$14, h6=$15
                     WHERE production_date=$16 AND line_name=$17 AND office_id=$18`,
                    [
                        rec.hourly_target, rec.h1, rec.h2, rec.h3, rec.h4, rec.h5, rec.h7, rec.h8, rec.h9, rec.h10,
                        rec.total_prod, rec.total_defect, rec.downtime_minute, rec.active_hours, rec.h6,
                        production_date, line_name, rec.office_id
                    ]
                );
            } else {
                await pool.query(
                    `INSERT INTO production_records 
                     (production_date, line_name, office_id, hourly_target, h1, h2, h3, h4, h5, h6, h7, h8, h9, h10, total_prod, total_defect, downtime_minute, active_hours)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
                    [
                        production_date, line_name, rec.office_id, rec.hourly_target,
                        rec.h1, rec.h2, rec.h3, rec.h4, rec.h5, rec.h6, rec.h7, rec.h8, rec.h9, rec.h10,
                        rec.total_prod, rec.total_defect, rec.downtime_minute, rec.active_hours
                    ]
                );
            }
        }
        res.json({ success: true, message: 'Production records updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/production-records', verifyToken, authorizeRoles('ADMIN', 'LINE_SUPERVISOR'), async (req, res) => {
    const { date, line } = req.query;
    try {
        const result = await pool.query(
            `SELECT * FROM production_records WHERE production_date = $1 AND line_name = $2`,
            [date, line]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

async function getTopPerformers() {
    const queryText = `
        SELECT 
            o.office_id, o.operator_name, o.line_name,
            ROUND(
                COALESCE(
                    (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100, 
                    0
                )::numeric, 1
            ) as efficiency
        FROM operators o
        JOIN production_records pr ON pr.office_id = o.office_id
        JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
        GROUP BY o.office_id, o.operator_name, o.line_name
        HAVING SUM((pr.active_hours * 60) - pr.downtime_minute) > 0
           -- 🎯 0.0% means no real production happened that period — exclude, don't rank as "top"
           AND ROUND(
                COALESCE(
                    (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100,
                    0
                )::numeric, 1
           ) > 0
        ORDER BY efficiency DESC
        LIMIT 3
    `;
    const result = await pool.query(queryText);
    return result.rows;
}

// ✅ UPDATED: Low performers are now only operators whose efficiency is genuinely below 50%
async function getLowPerformers() {
    const queryText = `
        SELECT 
            o.office_id, o.operator_name, o.line_name,
            ROUND(
                COALESCE(
                    (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100, 
                    0
                )::numeric, 1
            ) as efficiency
        FROM operators o
        JOIN production_records pr ON pr.office_id = o.office_id
        JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
        GROUP BY o.office_id, o.operator_name, o.line_name
        HAVING SUM((pr.active_hours * 60) - pr.downtime_minute) > 0
           -- 🎯 Only flag genuinely low (but real) performance: between 0% (exclusive) and 50%
           AND ROUND(
                COALESCE(
                    (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100,
                    0
                )::numeric, 1
           ) > 0
           AND ROUND(
                COALESCE(
                    (SUM(pr.total_prod - pr.total_defect) * 60 / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute) * ${CAPACITY_SQL_AGG}, 0)) * 100,
                    0
                )::numeric, 1
           ) < 50
        ORDER BY efficiency ASC
        LIMIT 20
    `;
    const result = await pool.query(queryText);
    return result.rows;
}

async function getProductionSummary(date) {
    const linesResult = await pool.query(`SELECT DISTINCT line_name FROM operator_assignments ORDER BY line_name`);
    const lines = linesResult.rows;
    const summaryData = [];

    for (const l of lines) {
        const lineName = l.line_name;
        const records = await pool.query(`
            SELECT 
                pr.*, oa.operator_name, oa.sam_value,
                ${CAPACITY_SQL} AS capacity
            FROM production_records pr
            JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
            WHERE pr.production_date = $1 AND pr.line_name = $2
        `, [date, lineName]);

        let totalActualOutput = 0;
        let totalExpectedOutput = 0;

        const operatorsFormatted = records.rows.map(rec => {
            const capacity = parseFloat(rec.capacity) || 0;
            const totalProd = rec.total_prod || 0;
            const defect = rec.total_defect || 0;
            const downtime = rec.downtime_minute || 0;
            const activeHours = rec.active_hours || 0;
            const netMins = (activeHours * 60) - downtime;
            const actualOutput = totalProd - defect;
            const expectedOutput = capacity * (netMins / 60);
            let eff = 0;
            if (netMins > 0 && expectedOutput > 0 && actualOutput > 0) eff = Math.round((actualOutput / expectedOutput) * 100);
            totalActualOutput += actualOutput;
            totalExpectedOutput += expectedOutput;
            return { ...rec, efficiency: eff };
        });

        let lineEff = 0;
        if (totalExpectedOutput > 0 && totalActualOutput > 0) {
            lineEff = Math.round((totalActualOutput / totalExpectedOutput) * 100);
        }

        summaryData.push({ line_name: lineName, line_efficiency: lineEff, operators: operatorsFormatted });
    }

    return summaryData;
}

// ==========================================
// 📊 DASHBOARD KPI BAR — derived entirely from the productionSummary data
// already fetched above (no extra per-line queries). Thresholds used:
// Achieved = line efficiency >= 90% | Warning = 60–89% | Critical = < 60%
// (adjust these two numbers below if you'd like different cutoffs)
// ==========================================
const KPI_ACHIEVED_THRESHOLD = 90;
const KPI_WARNING_THRESHOLD = 60;

function computeDashboardKPIs(summaryData, avgIeTarget) {
    const totalLines = summaryData.length;
    let achievedLines = 0, warningLines = 0, criticalLines = 0;
    let totalManpower = 0, totalTarget = 0, totalOutput = 0;
    let totalActualOutput = 0, totalExpectedOutput = 0;

    summaryData.forEach(line => {
        if (line.line_efficiency >= KPI_ACHIEVED_THRESHOLD) achievedLines++;
        else if (line.line_efficiency >= KPI_WARNING_THRESHOLD) warningLines++;
        else criticalLines++;

        line.operators.forEach(op => {
            totalManpower++;
            const activeHours = op.active_hours || 0;
            const downtime = op.downtime_minute || 0;
            const capacity = parseFloat(op.capacity) || 0;
            const totalProd = op.total_prod || 0;
            const defect = op.total_defect || 0;
            const netMins = (activeHours * 60) - downtime;
            totalTarget += (op.hourly_target || 0) * activeHours;
            totalOutput += totalProd;
            totalActualOutput += (totalProd - defect);
            totalExpectedOutput += capacity * (netMins / 60);
        });
    });

    const overallEfficiency = totalExpectedOutput > 0 ? (totalActualOutput / totalExpectedOutput) * 100 : 0;
    const pct = (count) => totalLines > 0 ? (count / totalLines) * 100 : 0;

    return {
        total_lines: totalLines,
        achieved_lines: achievedLines, achieved_pct: Math.round(pct(achievedLines) * 100) / 100,
        warning_lines: warningLines, warning_pct: Math.round(pct(warningLines) * 100) / 100,
        critical_lines: criticalLines, critical_pct: Math.round(pct(criticalLines) * 100) / 100,
        total_manpower: totalManpower,
        total_target: Math.round(totalTarget),
        total_output: Math.round(totalOutput),
        output_shortfall: Math.round(totalTarget - totalOutput),
        overall_efficiency: Math.round(overallEfficiency * 100) / 100,
        avg_ie_target: Math.round((avgIeTarget || 0) * 100) / 100,
        efficiency_gap: Math.round((avgIeTarget - overallEfficiency) * 100) / 100
    };
}

app.get('/api/dashboard/top-performers', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    try {
        res.json({ success: true, data: await getTopPerformers() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/low-performers', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    try {
        res.json({ success: true, data: await getLowPerformers() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/production-summary', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    const { date } = req.query;
    try {
        res.json({ success: true, data: await getProductionSummary(date) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/public/dashboard-data', async (req, res) => {
    try {
        const today = req.query.date || new Date().toISOString().split('T')[0];
        const [topPerformers, lowPerformers, productionSummary, avgIeResult] = await Promise.all([
            getTopPerformers(),
            getLowPerformers(),
            getProductionSummary(today),
            pool.query('SELECT AVG(ie_eff_pct) AS avg_eff FROM operator_assignments')
        ]);
        const avgIeTarget = parseFloat(avgIeResult.rows[0].avg_eff) || 0;
        const kpis = computeDashboardKPIs(productionSummary, avgIeTarget);
        res.json({ success: true, data: { topPerformers, lowPerformers, productionSummary, kpis } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});