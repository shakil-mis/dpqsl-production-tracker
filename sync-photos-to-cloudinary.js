// ===============================================================
// 📸 BULK PHOTO SYNC — uploads/ folder → Cloudinary
// ===============================================================
// Run this LOCALLY (on your own PC) whenever you've dropped a batch of new
// operator photos into the uploads/ folder, named by office_id — any image
// extension works (.jpg, .png, .gif, etc.), it does NOT have to be .jpg.
//
// ✅ SMART MODE: checks your live database first, and ONLY uploads photos
// for office_ids that actually exist in your `operators` table. Photos for
// people who were never entered as operators are skipped automatically.
//
// ✅ RETRY + CDN INVALIDATION: each upload is retried up to 3 times if the
// network hiccups (e.g. a temporary 502), and every upload forces Cloudinary
// to invalidate its CDN cache — so a fresh photo (or a previously-deleted
// one) never keeps showing a stale cached image in the app.
//
// Usage:
//   node sync-photos-to-cloudinary.js
//   (or)  npm run sync-photos
// ===============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : new Pool({ user: 'postgres', host: 'localhost', database: 'dpqsl_garments', password: '1234', port: 5432 });

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function uploadWithRetry(filePath, officeId) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await cloudinary.uploader.upload(filePath, {
                public_id: officeId,
                folder: 'dpqsl_operators',
                overwrite: true,
                invalidate: true,   // 🔑 forces Cloudinary's CDN to drop any stale cached copy immediately
                resource_type: 'image',
                format: 'jpg'
            });
            return true;
        } catch (err) {
            if (attempt < MAX_RETRIES) {
                console.log(`   ⏳ Retry ${attempt}/${MAX_RETRIES} for Office ID ${officeId} (${err.message})...`);
                await sleep(1500 * attempt); // back off a bit longer each retry
            } else {
                console.error(`❌ Failed for Office ID ${officeId} after ${MAX_RETRIES} attempts: ${err.message}`);
                return false;
            }
        }
    }
    return false;
}

async function main() {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        console.error('❌ CLOUDINARY_CLOUD_NAME not found — make sure you have a .env file in the project root with your Cloudinary keys.');
        process.exit(1);
    }
    if (!fs.existsSync(UPLOADS_DIR)) {
        console.error(`❌ Folder not found: ${UPLOADS_DIR}`);
        process.exit(1);
    }

    console.log('🔎 Fetching operator list from the database...');
    let validIds;
    try {
        const result = await pool.query('SELECT office_id FROM operators');
        validIds = new Set(result.rows.map(r => String(r.office_id)));
        console.log(`✅ Found ${validIds.size} operator(s) in the database.\n`);
    } catch (err) {
        console.error('❌ Could not connect to the database:', err.message);
        process.exit(1);
    }

    const files = fs.readdirSync(UPLOADS_DIR);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    let uploaded = 0, notAnOperator = 0, skipped = 0, failed = 0;

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const baseName = path.basename(file, ext);

        if (!imageExtensions.includes(ext)) continue;
        if (baseName.toLowerCase() === 'default') continue;
        if (!/^\d+$/.test(baseName)) {
            console.log(`⚠️  Skipping "${file}" — filename must be just the Office ID (e.g. 1775.gif)`);
            skipped++;
            continue;
        }

        // 🎯 The key filter: only upload if this office_id is a real operator
        if (!validIds.has(baseName)) {
            notAnOperator++;
            continue;
        }

        const officeId = baseName;
        const filePath = path.join(UPLOADS_DIR, file);

        const ok = await uploadWithRetry(filePath, officeId);
        if (ok) {
            console.log(`✅ Uploaded Office ID ${officeId} (from ${file})`);
            uploaded++;
        } else {
            failed++;
        }

        await sleep(150); // small pacing gap so we don't hammer Cloudinary/network back-to-back
    }

    console.log('\n--- Summary ---');
    console.log(`Uploaded: ${uploaded}  |  Skipped (not an existing operator): ${notAnOperator}  |  Skipped (invalid filename): ${skipped}  |  Failed (after retries): ${failed}`);
    await pool.end();
}

main();