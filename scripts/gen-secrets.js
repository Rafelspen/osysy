// Prints two fresh random secrets. Nothing is stored or sent anywhere: copy the
// values into Vercel (TOKEN_ENCRYPTION_KEY, CRON_SECRET) and the CRON_SECRET
// into the GitHub repo secret of the same name.
// Usage: npm run gen:secrets

const crypto = require("crypto");

console.log("TOKEN_ENCRYPTION_KEY=" + crypto.randomBytes(32).toString("base64"));
console.log("CRON_SECRET=" + crypto.randomBytes(24).toString("hex"));
console.log("\nKeep these private. CRON_SECRET must be identical in Vercel and GitHub.");
