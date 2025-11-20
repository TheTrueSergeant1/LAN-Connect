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

// --- SSL Certificate (Required for WebRTC/Video) ---
// Ensure key.pem and cert.pem are in the root folder
const options = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

const app = express();
const server = https.createServer(options, app);
const io = socketIo(server);

// --- Middleware Setup ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve CSS, JS, Sounds
app.use('/uploads', express.static('public/uploads')); // Serve uploaded files

// Session Config (Persists login state in SQLite)
app.use(session({
    store: new SQLiteStore(),
    secret: 'lan-cord-super-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true } // Secure cookies because we use HTTPS
}));

// File Upload Config
const upload = multer({ dest: 'public/uploads/' });

// --- Helper Middleware ---

// 1. Protect Routes (User must be logged in)
const requireAuth = (req, res, next) => {
    if (req.session.userId) return next();
    res.redirect('/login');
};

// 2. Protect Admin Routes (User must be 'admin')
const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') return next();
    res.status(403).send("403 Forbidden: You do not have clearance.");
};

// --- Routes: Authentication ---

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    
    // Insert into DB
    db.run(`INSERT INTO users (username, password, role, is_banned) VALUES (?, ?, 'user', 0)`, 
    [username, hash], (err) => {
        if (err) return res.send("Error: Username likely taken.");
        res.redirect('/login');
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.send("Invalid credentials");
        }
        
        // Check if Banned
        if (user.is_banned === 1) {
            return res.send("🚫 Access Denied: You have been permanently banned.");
        }

        // Set Session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- Routes: Main App ---

app.get('/', requireAuth, (req, res) => {
    res.render('chat', { username: req.session.username });
});

// Handle File Uploads (AJAX)
app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
    // In production, rename file to include extension here
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

// --- Routes: Admin Dashboard ---

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    // 1. Get Users
    db.all("SELECT id, username, role, is_banned FROM users", [], (err, users) => {
        // 2. Get Recent Messages
        db.all("SELECT id, username, content, timestamp FROM messages ORDER BY id DESC LIMIT 50", [], (err, messages) => {
            res.render('admin', { users, messages, myUser: req.session.username });
        });
    });
});

app.post('/admin/ban', requireAuth, requireAdmin, (req, res) => {
    const { userId } = req.body;
    db.run("UPDATE users SET is_banned = 1 WHERE id = ?", [userId], () => {
        // Disconnect user in real-time
        // Note: Ideally we map UserID to SocketID to kick them specifically.
        // Here we broadcast a ban event and clients check if it applies to them.
        res.redirect('/admin');
    });
});

app.post('/admin/delete-msg', requireAuth, requireAdmin, (req, res) => {
    const { msgId } = req.body;
    db.run("DELETE FROM messages WHERE id = ?", [msgId], () => {
        io.emit('msg-deleted', msgId);
        res.redirect('/admin');
    });
});

// --- Real-Time Logic (Socket.io) ---

// Maps to track state
const onlineUsers = new Map(); // socket.id -> username
const voiceUsers = new Map();  // socket.id -> username (Only those in voice)

io.on('connection', (socket) => {

    // 1. User joins the application (Text Chat)
    socket.on('join', (username) => {
        socket.username = username;
        onlineUsers.set(socket.id, username);
        
        socket.broadcast.emit('system-msg', `${username} joined the server.`);
        
        // Send updated lists to everyone
        io.emit('update-user-list', Array.from(onlineUsers.values()));
        io.emit('update-voice-list', Array.from(voiceUsers.values()));
    });

    // 2. Handle Disconnect (Cleanup)
    socket.on('disconnect', () => {
        const user = onlineUsers.get(socket.id);
        
        onlineUsers.delete(socket.id);
        voiceUsers.delete(socket.id); // Ensure they are removed from voice too

        io.emit('update-user-list', Array.from(onlineUsers.values()));
        io.emit('update-voice-list', Array.from(voiceUsers.values()));
        
        // If they were in voice, tell peers to remove their video stream
        socket.broadcast.emit('user-left-voice', socket.id);
    });

    // 3. Text Chat Messages
    socket.on('chat-msg', (msg) => {
        const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        // Save to DB
        db.run(`INSERT INTO messages (username, content, type) VALUES (?, ?, 'text')`, 
            [socket.username, msg], 
            function(err) {
                // Broadcast to all clients
                io.emit('chat-msg', { 
                    id: this.lastID, // Send DB ID (useful for deletion)
                    user: socket.username, 
                    text: msg, 
                    type: 'text', 
                    timestamp: time 
                });
        });
    });

    // 4. File Sharing
    socket.on('file-share', (fileData) => {
        const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        io.emit('chat-msg', { 
            user: socket.username, 
            text: fileData, 
            type: 'file', 
            timestamp: time 
        });
    });

    // 5. Voice Channel Management
    socket.on('join-voice', () => {
        voiceUsers.set(socket.id, socket.username);
        io.emit('update-voice-list', Array.from(voiceUsers.values()));
    });

    socket.on('leave-voice', () => {
        voiceUsers.delete(socket.id);
        io.emit('update-voice-list', Array.from(voiceUsers.values()));
        socket.broadcast.emit('user-left-voice', socket.id);
    });

    // 6. WebRTC Signaling (Video/Screen)
    // This relays the "handshake" data between two clients
    socket.on('signal', (data) => {
        io.to(data.target).emit('signal', {
            ...data,
            senderId: socket.id,   // Add Sender ID so receiver knows who this is
            senderUser: socket.username
        });
    });
});

// --- Start Server ---
server.listen(PORT, HOST, () => {
    console.log('--------------------------------------------------');
    console.log(`LAN-Cord Server Running`);
    console.log(`Address: https://${HOST}:${PORT}`);
    console.log(`Admin Dashboard: https://${HOST}:${PORT}/admin`);
    console.log('--------------------------------------------------');
});