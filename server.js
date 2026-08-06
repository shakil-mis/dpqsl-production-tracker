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
            { public_id: publicId, folder: 'dpqsl_operators', overwrite: true, resource_type: 'image', format: 'jpg' },
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
                                THEN (SUM((pr.total_prod - pr.total_defect) * oa.sam_value) / SUM((pr.active_hours * 60) - pr.downtime_minute)) * 100
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

app.post('/api/sam-records', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { style_name, process_name, sam_value, ie_eff_pct } = req.body;
    try {
        const sam = parseFloat(sam_value);
        const eff = parseFloat(ie_eff_pct);
        if (sam <= 0) return res.status(400).json({ success: false, message: 'SAM must be greater than 0!' });
        const result = await pool.query(
            `INSERT INTO sam_records (style_name, process_name, sam_value, ie_eff_pct) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [style_name, process_name, sam, eff]
        );
        res.json({ success: true, message: 'SAM record saved successfully!', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/sam-records', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sam_records ORDER BY id DESC');
        const updatedData = result.rows.map(row => {
            const sam = parseFloat(row.sam_value);
            const eff = parseFloat(row.ie_eff_pct);
            const hourlyTarget = Math.round((60 * (eff / 100)) / sam);
            return { ...row, hourly_target: isFinite(hourlyTarget) ? hourlyTarget : 0 };
        });
        res.json({ success: true, data: updatedData });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/sam-records/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { id } = req.params;
    const { style_name, process_name, sam_value, ie_eff_pct } = req.body;
    try {
        const sam = parseFloat(sam_value);
        const eff = parseFloat(ie_eff_pct);
        if (sam <= 0) return res.status(400).json({ success: false, message: 'SAM must be > 0!' });
        await pool.query(
            `UPDATE sam_records SET style_name=$1, process_name=$2, sam_value=$3, ie_eff_pct=$4 WHERE id=$5`,
            [style_name, process_name, sam, eff, id]
        );
        res.json({ success: true, message: 'SAM record updated successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/sam-records/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    try {
        await pool.query('DELETE FROM sam_records WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'SAM record deleted successfully!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/assignments', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { line_name, office_id, operator_name, style_name, process_name, ie_eff_pct, hourly_target, sam_value } = req.body;
    try {
        const checkDuplicate = await pool.query('SELECT * FROM operator_assignments WHERE office_id = $1 AND line_name = $2', [office_id, line_name]);
        if (checkDuplicate.rows.length > 0) return res.status(400).json({ success: false, message: 'Operator already assigned!' });
        const result = await pool.query(
            `INSERT INTO operator_assignments (line_name, office_id, operator_name, style_name, process_name, ie_eff_pct, hourly_target, sam_value) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [line_name, office_id, operator_name, style_name, process_name, ie_eff_pct, hourly_target, sam_value]
        );
        res.json({ success: true, message: 'Operator assigned successfully!', data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/assignments', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING', 'LINE_SUPERVISOR'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM operator_assignments ORDER BY id DESC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/assignments/:id', verifyToken, authorizeRoles('ADMIN', 'IE_PLANNING'), async (req, res) => {
    const { id } = req.params;
    const { line_name, office_id, operator_name, style_name, process_name, ie_eff_pct, hourly_target, sam_value } = req.body;
    try {
        await pool.query(
            `UPDATE operator_assignments SET line_name=$1, office_id=$2, operator_name=$3, style_name=$4, process_name=$5, ie_eff_pct=$6, hourly_target=$7, sam_value=$8 
             WHERE id=$9`,
            [line_name, office_id, operator_name, style_name, process_name, ie_eff_pct, hourly_target, sam_value, id]
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
                    (SUM((pr.total_prod - pr.total_defect) * oa.sam_value) / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute), 0)) * 100, 
                    0
                )::numeric, 1
            ) as efficiency
        FROM operators o
        JOIN production_records pr ON pr.office_id = o.office_id
        JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
        GROUP BY o.office_id, o.operator_name, o.line_name
        HAVING SUM((pr.active_hours * 60) - pr.downtime_minute) > 0
        ORDER BY efficiency DESC
        LIMIT 3
    `;
    const result = await pool.query(queryText);
    return result.rows;
}

// ✅ UPDATED: Low performers are now only operators whose efficiency is genuinely below 60%
async function getLowPerformers() {
    const queryText = `
        SELECT 
            o.office_id, o.operator_name, o.line_name,
            ROUND(
                COALESCE(
                    (SUM((pr.total_prod - pr.total_defect) * oa.sam_value) / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute), 0)) * 100, 
                    0
                )::numeric, 1
            ) as efficiency
        FROM operators o
        JOIN production_records pr ON pr.office_id = o.office_id
        JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
        GROUP BY o.office_id, o.operator_name, o.line_name
        HAVING SUM((pr.active_hours * 60) - pr.downtime_minute) > 0
           AND ROUND(
                COALESCE(
                    (SUM((pr.total_prod - pr.total_defect) * oa.sam_value) / NULLIF(SUM((pr.active_hours * 60) - pr.downtime_minute), 0)) * 100,
                    0
                )::numeric, 1
           ) < 60
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
                pr.*, oa.operator_name, oa.sam_value
            FROM production_records pr
            JOIN operator_assignments oa ON oa.office_id = pr.office_id AND oa.line_name = pr.line_name
            WHERE pr.production_date = $1 AND pr.line_name = $2
        `, [date, lineName]);

        let totalEarnedMinutes = 0;
        let totalNetMinutes = 0;

        const operatorsFormatted = records.rows.map(rec => {
            const sam = parseFloat(rec.sam_value) || 0;
            const totalProd = rec.total_prod || 0;
            const defect = rec.total_defect || 0;
            const downtime = rec.downtime_minute || 0;
            const activeHours = rec.active_hours || 0;
            const netMins = (activeHours * 60) - downtime;
            const earnedMins = (totalProd - defect) * sam;
            let eff = 0;
            if (netMins > 0 && earnedMins > 0) eff = Math.round((earnedMins / netMins) * 100);
            totalEarnedMinutes += earnedMins;
            totalNetMinutes += netMins;
            return { ...rec, efficiency: eff };
        });

        let lineEff = 0;
        if (totalNetMinutes > 0 && totalEarnedMinutes > 0) {
            lineEff = Math.round((totalEarnedMinutes / totalNetMinutes) * 100);
        }

        summaryData.push({ line_name: lineName, line_efficiency: lineEff, operators: operatorsFormatted });
    }

    return summaryData;
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
        const [topPerformers, lowPerformers, productionSummary] = await Promise.all([
            getTopPerformers(),
            getLowPerformers(),
            getProductionSummary(today)
        ]);
        res.json({ success: true, data: { topPerformers, lowPerformers, productionSummary } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});