// server.js - The Complete LAN-Cord Controller

const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const socketIo = require('socket.io');
const multer = require('multer');
const db = require('./database'); // Your database.js file

// --- Configuration ---
const PORT = 3000;
const IP_ADDRESS = '10.0.0.100';

// --- HTTPS Setup (Required for Camera/Mic access) ---
const app = express();
const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};
const server = https.createServer(options, app);
const io = socketIo(server);

// --- Middleware ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serves CSS, JS, Uploads, Icons
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }), // Store sessions in file
  secret: 'lan-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true } // Secure cookies for HTTPS
}));

// --- File Upload Config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- Trackers for Real-Time State ---
const onlineUsers = new Map(); // socketId -> username
const voiceUsers = new Map();  // socketId -> username (People in call)

// ==================================================================
// 1. AUTHENTICATION & MIDDLEWARE
// ==================================================================

// Middleware: Ensure user is logged in
const requireAuth = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect('/login');
};

// Middleware: Ensure user is Admin
const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') return next();
    res.status(403).send("403 Forbidden: You do not have clearance.");
};

// Login/Register Routes
app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  // Default role is 'user', not banned
  db.run(`INSERT INTO users (username, password, role, is_banned) VALUES (?, ?, 'user', 0)`, 
  [username, hash], (err) => {
    if (err) return res.send("Username taken or error occurred.");
    res.redirect('/login');
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.send("Invalid credentials");
    }
    if (user.is_banned === 1) {
        return res.send("🚫 Access Denied: You have been banned from this server.");
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role; 
    res.redirect('/');
  });
});

// ==================================================================
// 2. MAIN APPLICATION ROUTES
// ==================================================================

// Root: The Chat Interface
app.get('/', requireAuth, (req, res) => {
    // Load Chat History
    db.all("SELECT * FROM messages ORDER BY id ASC LIMIT 100", [], (err, rows) => {
        res.render('chat', { 
            username: req.session.username,
            messages: rows || [] 
        });
    });
});

// File Upload Endpoint
app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

// ==================================================================
// 3. ADMIN ROUTES
// ==================================================================

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    db.all("SELECT id, username, role, is_banned FROM users", [], (err, users) => {
        db.all("SELECT id, username, content, timestamp FROM messages ORDER BY id DESC LIMIT 50", [], (err, messages) => {
            res.render('admin', { users, messages, myUser: req.session.username });
        });
    });
});

app.post('/admin/ban', requireAuth, requireAdmin, (req, res) => {
    const { userId } = req.body;
    db.run("UPDATE users SET is_banned = 1 WHERE id = ?", [userId], () => {
        // Real-time: Kick user logic would go here
        io.emit('user-banned', userId); 
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

// ==================================================================
// 4. REAL-TIME CONTROLLER (SOCKET.IO)
// ==================================================================

io.on('connection', (socket) => {
  
  // --- A. Connection Logic ---
  socket.on('join', (username) => {
    socket.username = username;
    onlineUsers.set(socket.id, username);
    
    // Notify others
    socket.broadcast.emit('system-msg', `${username} joined the server.`);
    
    // Update lists for everyone
    io.emit('update-user-list', Array.from(onlineUsers.values()));
    io.emit('update-voice-list', Array.from(voiceUsers.values()));
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    voiceUsers.delete(socket.id);
    
    io.emit('update-user-list', Array.from(onlineUsers.values()));
    io.emit('update-voice-list', Array.from(voiceUsers.values()));
    
    // If they were in a call, tell others to remove their video
    socket.broadcast.emit('user-left-voice', socket.id);
  });

  // --- B. Chat Logic ---
  socket.on('chat-msg', (msg) => {
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    // Save to Database
    db.run(`INSERT INTO messages (username, content, type, timestamp) VALUES (?, ?, 'text', ?)`, 
        [socket.username, msg, time]);
    
    // Emit to clients
    io.emit('chat-msg', { user: socket.username, text: msg, type: 'text', timestamp: time });
  });

  socket.on('file-share', (fileData) => {
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const fileString = JSON.stringify(fileData);

    // Save to Database (Stored as JSON string)
    db.run(`INSERT INTO messages (username, content, type, timestamp) VALUES (?, ?, 'file', ?)`, 
        [socket.username, fileString, time]);

    io.emit('chat-msg', { user: socket.username, text: fileData, type: 'file', timestamp: time });
  });

  // --- C. Voice & Video Logic ---
  socket.on('join-voice', () => {
    voiceUsers.set(socket.id, socket.username);
    io.emit('update-voice-list', Array.from(voiceUsers.values()));
  });

  socket.on('leave-voice', () => {
    voiceUsers.delete(socket.id);
    io.emit('update-voice-list', Array.from(voiceUsers.values()));
    socket.broadcast.emit('user-left-voice', socket.id);
  });

  // --- D. WebRTC Signaling (The Mesh Network) ---
  socket.on('signal', (data) => {
    const payload = {
        ...data,
        senderId: socket.id,
        senderUser: socket.username
    };

    if (data.target) {
        // Direct Message (Offer/Answer/Candidate)
        io.to(data.target).emit('signal', payload);
    } else {
        // Broadcast (Join Request) - Announcement to everyone else
        socket.broadcast.emit('signal', payload);
    }
  });

});

// ==================================================================
// 5. START SERVER
// ==================================================================

server.listen(PORT, IP_ADDRESS, () => {
  console.log(`-----------------------------------------------`);
  console.log(` LAN-Cord Server is Online!`);
  console.log(` Secure Access: https://${IP_ADDRESS}:${PORT}`);
  console.log(` Admin Panel:   https://${IP_ADDRESS}:${PORT}/admin`);
  console.log(`-----------------------------------------------`);
});