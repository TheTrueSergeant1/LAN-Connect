// server.js
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const socketIo = require('socket.io');
const multer = require('multer');
const db = require('./database'); // Assumes database.js is in the same folder

// --- 1. INITIAL SETUP & CONFIGURATION ---

// Auto-create uploads directory to prevent errors
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();

// HTTPS Configuration (Required for Camera/Mic access)
const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};
const server = https.createServer(options, app);
const io = socketIo(server);

// --- 2. MIDDLEWARE ---

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session Configuration (Persists logins across restarts)
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
  secret: 'lan-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true } // Secure cookies for HTTPS
}));

// Multer Configuration (File Uploads)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/')
  },
  filename: function (req, file, cb) {
    // Generate unique filename but keep original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname)); 
  }
});
const upload = multer({ storage: storage });

// --- 3. AUTHENTICATION & PERMISSIONS ---

// Middleware: Check if user is logged in
const requireAuth = (req, res, next) => {
  if (req.session.userId) return next();
  res.redirect('/login');
};

// Middleware: Check if user is Admin
const requireAdmin = (req, res, next) => {
    if (req.session.role === 'admin') return next();
    res.status(403).send("403 Forbidden: You do not have clearance.");
};

// --- 4. ROUTES ---

// Root: Load Chat Interface & History
app.get('/', requireAuth, (req, res) => {
    // Fetch message history (Ascending order for chat flow)
    db.all("SELECT * FROM messages ORDER BY id ASC", [], (err, rows) => {
        res.render('chat', { 
            username: req.session.username, 
            messages: rows || [] 
        });
    });
});

// Login Page
app.get('/login', (req, res) => {
  res.render('login');
});

// Login Action
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.send("Invalid credentials");
    }
    // Check Ban Status
    if (user.is_banned === 1) {
        return res.send("🚫 Access Denied: You have been banned from this server.");
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
  // Default role is 'user', not banned
  db.run(`INSERT INTO users (username, password, role, is_banned) VALUES (?, ?, 'user', 0)`, [username, hash], (err) => {
    if (err) return res.send("Username taken or error occurred.");
    res.redirect('/login');
  });
});

// File Upload Endpoint
app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Return file details to client so they can emit via Socket
  res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

// --- 5. ADMIN ROUTES ---

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
        // Broadcast ban event to kick user immediately if online
        io.emit('user-banned', userId); 
        res.redirect('/admin');
    });
});

app.post('/admin/delete-msg', requireAuth, requireAdmin, (req, res) => {
    const { msgId } = req.body;
    db.run("DELETE FROM messages WHERE id = ?", [msgId], () => {
        // Broadcast delete event to remove bubble from all screens
        io.emit('msg-deleted', msgId);
        res.redirect('/admin');
    });
});

// --- 6. REAL-TIME SOCKET LOGIC ---

// Track active connections
const onlineUsers = new Map(); // socketId -> username
const voiceUsers = new Map();  // socketId -> username (Voice Channel)

io.on('connection', (socket) => {
  
  // A. Join Event
  socket.on('join', (username) => {
    socket.username = username;
    onlineUsers.set(socket.id, username);
    
    // Broadcast presence
    socket.broadcast.emit('system-msg', `${username} joined.`);
    io.emit('update-user-list', Array.from(onlineUsers.values()));
    io.emit('update-voice-list', Array.from(voiceUsers.values()));
  });

  // B. Chat Message
  socket.on('chat-msg', (msg) => {
    if (!socket.username) return;
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    // Save to DB
    db.run(`INSERT INTO messages (username, content, type, timestamp) VALUES (?, ?, 'text', ?)`, 
        [socket.username, msg, time], function(err) {
            // Emit with DB ID (useful for admin deletion)
            io.emit('chat-msg', { 
                id: this.lastID,
                user: socket.username, 
                text: msg, 
                type: 'text', 
                timestamp: time 
            });
        });
  });

  // C. File Share
  socket.on('file-share', (fileData) => {
    if (!socket.username) return;
    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const fileString = JSON.stringify(fileData);
    
    db.run(`INSERT INTO messages (username, content, type, timestamp) VALUES (?, ?, 'file', ?)`, 
        [socket.username, fileString, time], function(err) {
            io.emit('chat-msg', { 
                id: this.lastID,
                user: socket.username, 
                text: fileData, 
                type: 'file', 
                timestamp: time 
            });
        });
  });

  // D. Voice Channel Logic
  socket.on('join-voice', () => {
      if (!socket.username) return;
      voiceUsers.set(socket.id, socket.username);
      io.emit('update-voice-list', Array.from(voiceUsers.values()));
  });

  socket.on('leave-voice', () => {
      voiceUsers.delete(socket.id);
      io.emit('update-voice-list', Array.from(voiceUsers.values()));
      socket.broadcast.emit('user-left-voice', socket.id);
  });

  // E. WebRTC Signaling (Mesh Network Routing)
  socket.on('signal', (data) => {
    const payload = {
        ...data,
        senderId: socket.id,
        senderUser: socket.username
    };

    if (data.target) {
        // Direct routing (Offer/Answer/Candidate)
        io.to(data.target).emit('signal', payload);
    } else {
        // Broadcast (Join Request) - Send to everyone else
        socket.broadcast.emit('signal', payload);
    }
  });

  // F. Disconnect
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    if (voiceUsers.has(socket.id)) {
        voiceUsers.delete(socket.id);
        io.emit('update-voice-list', Array.from(voiceUsers.values()));
        socket.broadcast.emit('user-left-voice', socket.id);
    }
    io.emit('update-user-list', Array.from(onlineUsers.values()));
  });

});

// --- 7. START SERVER ---

// Listen on 0.0.0.0 to be accessible by the whole LAN
server.listen(3000, '0.0.0.0', () => {
  console.log('--------------------------------------------------');
  console.log('LAN-Cord Server Online');
  console.log('--------------------------------------------------');
  console.log('Local Access:   https://localhost:3000');
  console.log('LAN Access:     https://10.0.0.100:3000');
  console.log('--------------------------------------------------');
});