// ===============================================================
// 📸 BULK PHOTO SYNC — uploads/ folder → Cloudinary
// ===============================================================
// Run this LOCALLY (on your own PC) whenever you've dropped a batch of new
// operator photos into the uploads/ folder, named by office_id — any image
// extension works (.jpg, .png, .gif, etc.), it does NOT have to be .jpg.
//
// ✅ SMART MODE: this now checks your live database first, and ONLY
// uploads photos for office_ids that actually exist in your `operators`
// table. Photos in uploads/ for people who were never entered as
// operators are skipped automatically — no manual filtering needed.
//
// It reads .env for your Cloudinary + Database credentials, so this only
// works from your project folder where .env already exists.
//
// Usage:
//   node sync-photos-to-cloudinary.js
//   (or)  npm run sync-photos
//
// What it does:
//   1. Connects to your database and pulls the list of valid office_ids
//   2. Scans uploads/ for files named <office_id>.<ext> (any image extension)
//   3. Skips any file whose office_id is NOT a real operator in the database
//   4. Skips default.jpg / default.* (that's the fallback avatar, not an operator)
//   5. Uploads the rest to Cloudinary as public_id = office_id, converted to
//      .jpg (matches the URL pattern the app already uses — .gif/.png source
//      files are fine, Cloudinary re-encodes them)
//   6. Overwrites if that office_id's photo already exists on Cloudinary
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

async function main() {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        console.error('❌ CLOUDINARY_CLOUD_NAME not found — make sure you have a .env file in the project root with your Cloudinary keys.');
        process.exit(1);
    }
    if (!fs.existsSync(UPLOADS_DIR)) {
        console.error(`❌ Folder not found: ${UPLOADS_DIR}`);
        process.exit(1);
    }

    // Step 1: get the real list of operator office_ids from the database
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

        try {
            await cloudinary.uploader.upload(filePath, {
                public_id: officeId,
                folder: 'dpqsl_operators',
                overwrite: true,
                resource_type: 'image',
                format: 'jpg'
            });
            console.log(`✅ Uploaded Office ID ${officeId} (from ${file})`);
            uploaded++;
        } catch (err) {
            console.error(`❌ Failed for ${file}: ${err.message}`);
            failed++;
        }
    }

    console.log('\n--- Summary ---');
    console.log(`Uploaded: ${uploaded}  |  Skipped (not an existing operator): ${notAnOperator}  |  Skipped (invalid filename): ${skipped}  |  Failed: ${failed}`);
    await pool.end();
}

main();