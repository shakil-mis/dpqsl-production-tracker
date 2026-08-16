// ===============================================================
// 🧹 CLEAR ALL PHOTOS FROM CLOUDINARY (dpqsl_operators folder)
// ===============================================================
// Run this ONCE before re-syncing photos, to wipe out everything you
// already uploaded (e.g. from the earlier bulk 8,175-photo run) and
// start clean with only real operators' photos.
//
// Usage:
//   node clear-cloudinary-photos.js
//   (or)  npm run clear-photos
//
// ⚠️ This permanently deletes every image inside the "dpqsl_operators"
// folder on Cloudinary. It does NOT touch anything outside that folder.
// ===============================================================

require('dotenv').config();
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function main() {
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
        console.error('❌ CLOUDINARY_CLOUD_NAME not found — make sure your .env file has your Cloudinary keys.');
        process.exit(1);
    }

    console.log('🧹 Deleting all photos inside the "dpqsl_operators" folder on Cloudinary...\n');

    try {
        let totalDeleted = 0;
        let result;
        // Cloudinary deletes in batches of up to ~a few hundred per call, so loop until nothing's left.
        do {
            result = await cloudinary.api.delete_resources_by_prefix('dpqsl_operators/', { resource_type: 'image', invalidate: true });
            const count = Object.keys(result.deleted || {}).length;
            totalDeleted += count;
            console.log(`Deleted ${count} photo(s) this batch (running total: ${totalDeleted})`);
        } while (result.partial); // Cloudinary sets partial:true if there's more to delete

        // Remove the now-empty folder itself too
        try { await cloudinary.api.delete_folder('dpqsl_operators'); } catch (e) { /* fine if it's already gone */ }

        console.log(`\n✅ Done — ${totalDeleted} photo(s) removed from Cloudinary.`);
    } catch (err) {
        console.error('❌ Error while clearing photos:', err.message);
    }
}

main();
