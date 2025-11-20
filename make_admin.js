const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./lancord.db');

// REPLACE 'your_username' WITH YOUR ACTUAL USERNAME
const myUser = 'daniel'; 

db.run("UPDATE users SET role = 'admin' WHERE username = ?", [myUser], function(err) {
    if(err) console.log(err);
    else console.log(`User ${myUser} is now an Admin.`);
});