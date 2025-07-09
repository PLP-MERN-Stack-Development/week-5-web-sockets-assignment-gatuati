require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const socketHandlers = require('./socket/socketHandlers');
const app = express();
app.use(cors());
app.use(express.json());

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB file size limit
  }
});

const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3001",
    methods: ["GET", "POST"]
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  }
});

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    url: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    fileSize: req.file.size
  });
});

// Store users and rooms
const users = {};
const rooms = {
  general: new Set(),
  random: new Set()
};

// Store message history with improved structure
const messageHistory = {
  global: {
    messages: [],
    lastPrune: Date.now()
  },
  rooms: {
    general: {
      messages: [],
      lastPrune: Date.now()
    },
    random: {
      messages: [],
      lastPrune: Date.now()
    }
  },
  private: {}
};

// Prune old messages to prevent memory issues
const pruneOldMessages = () => {
  const now = Date.now();
  const pruneInterval = 24 * 60 * 60 * 1000; // 24 hours
  const maxMessages = 1000; // Max messages per channel

  // Prune global messages
  if (now - messageHistory.global.lastPrune > pruneInterval) {
    messageHistory.global.messages = messageHistory.global.messages.slice(-maxMessages);
    messageHistory.global.lastPrune = now;
  }

  // Prune room messages
  for (const room in messageHistory.rooms) {
    if (now - messageHistory.rooms[room].lastPrune > pruneInterval) {
      messageHistory.rooms[room].messages = messageHistory.rooms[room].messages.slice(-maxMessages);
      messageHistory.rooms[room].lastPrune = now;
    }
  }

  // Prune private messages
  for (const conversation in messageHistory.private) {
    if (now - messageHistory.private[conversation].lastPrune > pruneInterval) {
      messageHistory.private[conversation].messages = 
        messageHistory.private[conversation].messages.slice(-maxMessages);
      messageHistory.private[conversation].lastPrune = now;
    }
  }
};

// Run pruning every hour
setInterval(pruneOldMessages, 60 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // User registration
  socket.on('register', (username, ack) => {
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return ack({ success: false, error: 'Invalid username' });
    }

    if (Object.values(users).includes(username.trim())) {
      return ack({ success: false, error: 'Username already taken' });
    }

    users[socket.id] = username.trim();
    socket.join('general');
    rooms.general.add(username.trim());
    
    // Notify all users
    socket.broadcast.emit('userJoined', username.trim());
    io.to('general').emit('roomUpdate', { 
      room: 'general', 
      users: Array.from(rooms.general) 
    });
    io.emit('updateUsers', Object.values(users));
    
    console.log(`${username.trim()} joined the chat`);
    ack({ success: true, username: username.trim() });
  });

  // Handle public messages
  socket.on('message', (message, ack) => {
    const username = users[socket.id];
    if (!username) {
      return ack({ success: false, error: 'Not registered' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return ack({ success: false, error: 'Message cannot be empty' });
    }

    const msgData = {
      username,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      room: 'global'
    };

    // Store message
    messageHistory.global.messages.push(msgData);
    io.emit('message', msgData);
    ack({ success: true, timestamp: msgData.timestamp });
  });

  // Handle room messages
  socket.on('roomMessage', ({ room, message }, ack) => {
    const username = users[socket.id];
    if (!username) {
      return ack({ success: false, error: 'Not registered' });
    }

    if (!rooms[room]?.has(username)) {
      return ack({ success: false, error: 'Not in this room' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return ack({ success: false, error: 'Message cannot be empty' });
    }

    const msgData = {
      username,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      room
    };

    // Store message
    messageHistory.rooms[room].messages.push(msgData);
    io.to(room).emit('roomMessage', msgData);
    ack({ success: true, timestamp: msgData.timestamp });
  });

  // Handle private messages
  socket.on('privateMessage', ({ recipient, message }, ack) => {
    const sender = users[socket.id];
    if (!sender) {
      return ack({ success: false, error: 'Not registered' });
    }

    if (!recipient || !Object.values(users).includes(recipient)) {
      return ack({ success: false, error: 'Recipient not found' });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return ack({ success: false, error: 'Message cannot be empty' });
    }

    const recipientSocketId = Object.keys(users).find(
      id => users[id] === recipient
    );

    const msgData = {
      sender,
      recipient,
      message: message.trim(),
      timestamp: new Date().toISOString()
    };

    // Store private messages
    const conversationKey = [sender, recipient].sort().join('-');
    if (!messageHistory.private[conversationKey]) {
      messageHistory.private[conversationKey] = {
        messages: [],
        lastPrune: Date.now()
      };
    }
    messageHistory.private[conversationKey].messages.push(msgData);

    if (recipientSocketId) {
      io.to(recipientSocketId).emit('privateMessage', msgData);
    }
    socket.emit('privateMessage', { ...msgData, isSender: true });
    ack({ success: true, timestamp: msgData.timestamp });
  });

  // Handle file messages
  socket.on('fileMessage', ({ recipient, fileUrl, originalName, fileSize }, ack) => {
    const sender = users[socket.id];
    if (!sender) {
      return ack({ success: false, error: 'Not registered' });
    }

    if (!fileUrl || !originalName) {
      return ack({ success: false, error: 'Invalid file data' });
    }

    const data = {
      sender,
      recipient,
      fileUrl,
      originalName,
      fileSize,
      timestamp: new Date().toISOString(),
      isFile: true
    };

    if (recipient === 'all') {
      // Public file message
      io.emit('fileMessage', data);
      
      // Store in global history
      messageHistory.global.messages.push({
        username: sender,
        message: fileUrl,
        originalName,
        fileSize,
        isFile: true,
        timestamp: data.timestamp,
        room: 'global'
      });
    } else {
      // Private file message
      if (!Object.values(users).includes(recipient)) {
        return ack({ success: false, error: 'Recipient not found' });
      }

      const recipientSocketId = Object.keys(users).find(
        id => users[id] === recipient
      );

      // Store in private history
      const conversationKey = [sender, recipient].sort().join('-');
      if (!messageHistory.private[conversationKey]) {
        messageHistory.private[conversationKey] = {
          messages: [],
          lastPrune: Date.now()
        };
      }
      messageHistory.private[conversationKey].messages.push({
        sender,
        recipient,
        message: fileUrl,
        originalName,
        fileSize,
        isFile: true,
        timestamp: data.timestamp
      });

      if (recipientSocketId) {
        io.to(recipientSocketId).emit('fileMessage', data);
      }
      socket.emit('fileMessage', { ...data, isSender: true });
    }
    ack({ success: true, timestamp: data.timestamp });
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    const username = users[socket.id];
    if (!username) return;

    socket.broadcast.emit('typing', {
      ...data,
      username
    });
  });

  // Handle room joining
  socket.on('joinRoom', (room, ack) => {
    const username = users[socket.id];
    if (!username) {
      return ack({ success: false, error: 'Not registered' });
    }

    if (!rooms[room]) {
      return ack({ success: false, error: 'Room does not exist' });
    }

    // Leave all rooms except private messages
    socket.rooms.forEach(r => {
      if (r !== socket.id && r !== 'general' && r !== 'random') {
        socket.leave(r);
      }
    });

    // Join new room
    socket.join(room);
    rooms[room].add(username);

    // Notify room members
    io.to(room).emit('roomUpdate', { 
      room, 
      users: Array.from(rooms[room]) 
    });
    
    // Send room history
    ack({ 
      success: true,
      history: messageHistory.rooms[room].messages.slice(-50),
      users: Array.from(rooms[room])
    });
    
    console.log(`${username} joined room ${room}`);
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    const username = users[socket.id];
    if (!username) return;

    // Remove user from all rooms
    Object.keys(rooms).forEach(room => {
      if (rooms[room].delete(username)) {
        io.to(room).emit('roomUpdate', { 
          room, 
          users: Array.from(rooms[room]) 
        });
      }
    });

    delete users[socket.id];
    socket.broadcast.emit('userLeft', username);
    io.emit('updateUsers', Object.values(users));
    
    console.log(`${username} left the chat (${reason})`);
  });

  // Get message history
  socket.on('getHistory', ({ type, name, limit = 20 }, ack) => {
    if (limit > 100) limit = 100; // Enforce maximum limit
    
    let history = [];
    if (type === 'global') {
      history = messageHistory.global.messages.slice(-limit);
    } else if (type === 'room' && messageHistory.rooms[name]) {
      history = messageHistory.rooms[name].messages.slice(-limit);
    } else if (type === 'private') {
      const conversationKey = name.split('-').sort().join('-');
      if (messageHistory.private[conversationKey]) {
        history = messageHistory.private[conversationKey].messages.slice(-limit);
      }
    }
    ack({ history });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});
socketHandlers(io); // Add this line
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Create uploads directory if it doesn't exist
  const fs = require('fs');
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
  }
});