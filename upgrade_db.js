const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lancord.db');

db.serialize(() => {
    // Add role column (default to 'user')
    db.run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'", (err) => {
        if (!err) console.log("Added 'role' column.");
    });

    // Add banned column (default to 0 which means false)
    db.run("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0", (err) => {
        if (!err) console.log("Added 'is_banned' column.");
    });
});