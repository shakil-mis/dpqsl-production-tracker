// ===============================================================
// 📸 BULK PHOTO SYNC — uploads/ folder → Cloudinary
// ===============================================================
// Run this LOCALLY (on your own PC) whenever you've dropped a batch of new
// operator photos into the uploads/ folder, named by office_id — any image
// extension works (.jpg, .png, .gif, etc.), it does NOT have to be .jpg.
//
// It reads .env for your Cloudinary credentials, so this only works from
// your project folder where .env already exists (same one server.js uses).
//
// Usage:
//   node scripts/sync-photos-to-cloudinary.js
//   (or)  npm run sync-photos
//
// What it does:
//   - Scans uploads/ for files whose name (minus extension) is purely numeric
//     (i.e. looks like an office_id) — e.g. 1775.gif, 1980.png, 2044.jpg
//   - Skips default.jpg / default.* (that's the fallback avatar, not an operator)
//   - Uploads each to Cloudinary as public_id = office_id, converting it to
//     .jpg automatically (matches the same URL pattern the app already uses,
//     so .gif/.png source files are perfectly fine — Cloudinary re-encodes them)
//   - Overwrites if that office_id's photo already exists on Cloudinary
// ===============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

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

    const files = fs.readdirSync(UPLOADS_DIR);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    let uploaded = 0, skipped = 0, failed = 0;

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const baseName = path.basename(file, ext);

        if (!imageExtensions.includes(ext)) continue;               // not an image — skip
        if (baseName.toLowerCase() === 'default') continue;          // that's the fallback avatar — skip
        if (!/^\d+$/.test(baseName)) {                                // filename isn't purely numeric — not an office_id
            console.log(`⚠️  Skipping "${file}" — filename must be just the Office ID (e.g. 1775.gif)`);
            skipped++;
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
                format: 'jpg'   // always normalize to jpg, regardless of source (.gif, .png, etc.)
            });
            console.log(`✅ Uploaded Office ID ${officeId} (from ${file})`);
            uploaded++;
        } catch (err) {
            console.error(`❌ Failed for ${file}: ${err.message}`);
            failed++;
        }
    }

    console.log('\n--- Summary ---');
    console.log(`Uploaded: ${uploaded}  |  Skipped (not a valid office_id file): ${skipped}  |  Failed: ${failed}`);
}

main();
