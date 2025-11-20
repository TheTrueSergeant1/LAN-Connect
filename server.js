const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const db = require('./database');

// --- Configuration ---
const PORT = 3000;
const HOST = '10.0.0.100'; // Your Server IP
const SESSION_SECRET = 'lan-super-secret-key-change-this';

// --- SSL Certificates (Required for WebRTC) ---
// Ensure key.pem and cert.pem are in the root folder
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// --- App Setup ---
const app = express();
const server = https.createServer(options, app);
const io = socketIo(server);

// Middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    store: new SQLiteStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true } // Secure cookies because we are using HTTPS
}));

// File Upload Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => {
        // Keep original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Global Variables ---
const onlineUsers = new Map(); // SocketID -> Username

// --- Middleware Functions ---

// 1. Check if User is Logged In
const requireAuth = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// 2. Check if User is Admin
const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') return next();
    res.status(403).send("<h1>403 Forbidden</h1><p>You do not have clearance to access the Command Center.</p>");
};

// --- Routes ---

// Login Page
app.get('/login', (req, res) => {
    res.render('login');
});

// Login Action
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user || !bcrypt.compareSync(password, user.password)) {
            return res.send(`<h2 style="color:white; background:#222; padding:20px;">Invalid Credentials. <a href='/login'>Try Again</a></h2>`);
        }
        
        // Check Ban Status
        if (user.is_banned === 1) {
            return res.send(`<h2 style="color:red; background:#111; padding:20px;">🚫 Access Denied: You have been banned from this server.</h2>`);
        }

        // Set Session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role; 
        res.redirect('/');
    });
});

// Register Action
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    
    // Default role is 'user', is_banned is 0
    db.run(`INSERT INTO users (username, password, role, is_banned) VALUES (?, ?, 'user', 0)`, [username, hash], (err) => {
        if (err) return res.send(`<h2 style="color:white;">Username taken. <a href='/login'>Back</a></h2>`);
        res.redirect('/login');
    });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Main Chat App
app.get('/', requireAuth, (req, res) => {
    res.render('chat', { username: req.session.username });
});

// File Upload Endpoint
app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ 
        filename: req.file.filename, 
        originalName: req.file.originalname 
    });
});

// --- Admin Routes ---

// Dashboard
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    db.all("SELECT id, username, role, is_banned FROM users", [], (err, users) => {
        db.all("SELECT id, username, content, timestamp FROM messages ORDER BY id DESC LIMIT 50", [], (err, messages) => {
            res.render('admin', { users, messages, myUser: req.session.username });
        });
    });
});

// Ban User
app.post('/admin/ban', requireAuth, requireAdmin, (req, res) => {
    const { userId } = req.body;
    db.run("UPDATE users SET is_banned = 1 WHERE id = ?", [userId], () => {
        io.emit('user-banned', userId); // Notify clients
        res.redirect('/admin');
    });
});

// Delete Message
app.post('/admin/delete-msg', requireAuth, requireAdmin, (req, res) => {
    const { msgId } = req.body;
    db.run("DELETE FROM messages WHERE id = ?", [msgId], () => {
        io.emit('msg-deleted', msgId); // Notify clients
        res.redirect('/admin');
    });
});


// --- Real-Time Socket Logic ---

io.on('connection', (socket) => {
    
    // User Joins
    socket.on('join', (username) => {
        socket.username = username;
        onlineUsers.set(socket.id, username);
        
        // Broadcast to others
        socket.broadcast.emit('system-msg', `${username} joined the server.`);
        // Update Sidebar for everyone
        io.emit('update-user-list', Array.from(onlineUsers.values()));
    });

    // User Disconnects
    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.id);
            io.emit('update-user-list', Array.from(onlineUsers.values()));
        }
    });

    // Chat Messages
    socket.on('chat-msg', (msg) => {
        const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        // Insert into DB and get the ID (this refers to 'this.lastID' in sqlite3)
        db.run(`INSERT INTO messages (username, content, type) VALUES (?, ?, 'text')`, [socket.username, msg], function(err) {
            if (!err) {
                io.emit('chat-msg', { 
                    id: this.lastID, // Send DB ID so Admin can delete it later if needed
                    user: socket.username, 
                    text: msg, 
                    type: 'text', 
                    timestamp: timestamp 
                });
            }
        });
    });

    // File Sharing
    socket.on('file-share', (fileData) => {
        const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        // Save metadata as JSON string in content column for simplicity
        const contentStr = JSON.stringify(fileData);
        
        db.run(`INSERT INTO messages (username, content, type) VALUES (?, ?, 'file')`, [socket.username, contentStr], function(err) {
             if (!err) {
                io.emit('chat-msg', { 
                    id: this.lastID,
                    user: socket.username, 
                    text: fileData, 
                    type: 'file', 
                    timestamp: timestamp 
                });
             }
        });
    });

    // --- WebRTC Signaling (Mesh Network) ---
    socket.on('signal', (data) => {
        // Pass signals (Offer, Answer, ICE Candidates) to other clients
        socket.broadcast.emit('signal', data);
    });
});

// --- Start Server ---
server.listen(PORT, HOST, () => {
    console.log('--------------------------------------------------');
    console.log(`🚀 LAN-Cord Server Running!`);
    console.log(`🔗 Access: https://${HOST}:${PORT}`);
    console.log(`🔐 Admin:  https://${HOST}:${PORT}/admin`);
    console.log('--------------------------------------------------');
});