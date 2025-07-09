module.exports = (io) => {
  const users = {};
  const rooms = {
    general: new Set(),
    random: new Set()
  };
  
  // Store message history
  const messageHistory = {
    general: [],
    random: [],
    private: {}
  };

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User registration
    socket.on('register', (username) => {
      if (users[socket.id]) return;
      
      users[socket.id] = username;
      socket.join('general');
      rooms.general.add(username);
      
      // Notify all users
      socket.broadcast.emit('userJoined', username);
      io.to('general').emit('roomUpdate', Array.from(rooms.general));
      io.emit('updateUsers', Object.values(users));
      
      console.log(`${username} joined the chat`);
    });

    // Handle public messages
    socket.on('message', (message) => {
      const username = users[socket.id];
      if (!username) return;

      const msgData = {
        username,
        message,
        timestamp: new Date().toISOString(),
        room: 'general'
      };

      // Store message
      messageHistory.general.push(msgData);
      if (messageHistory.general.length > 100) {
        messageHistory.general.shift();
      }

      io.emit('message', msgData);
    });

    // Handle room messages
    socket.on('roomMessage', ({ room, message }) => {
      const username = users[socket.id];
      if (!username || !rooms[room]?.has(username)) return;

      const msgData = {
        username,
        message,
        timestamp: new Date().toISOString(),
        room
      };

      // Store message
      messageHistory[room].push(msgData);
      if (messageHistory[room].length > 100) {
        messageHistory[room].shift();
      }

      io.to(room).emit('roomMessage', msgData);
    });

    // Handle private messages
    socket.on('privateMessage', ({ recipient, message }) => {
      const sender = users[socket.id];
      if (!sender) return;

      const recipientSocketId = Object.keys(users).find(
        id => users[id] === recipient
      );

      if (recipientSocketId) {
        const msgData = {
          sender,
          recipient,
          message,
          timestamp: new Date().toISOString()
        };

        // Store private messages
        const conversationKey = [sender, recipient].sort().join('-');
        if (!messageHistory.private[conversationKey]) {
          messageHistory.private[conversationKey] = [];
        }
        messageHistory.private[conversationKey].push(msgData);
        if (messageHistory.private[conversationKey].length > 100) {
          messageHistory.private[conversationKey].shift();
        }

        io.to(recipientSocketId).emit('privateMessage', msgData);
        socket.emit('privateMessage', { ...msgData, isSender: true });
      }
    });

    // Handle file messages
    socket.on('fileMessage', ({ recipient, fileUrl, originalName }) => {
      const sender = users[socket.id];
      if (!sender) return;

      const data = {
        sender,
        recipient,
        fileUrl,
        originalName,
        timestamp: new Date().toISOString(),
        isFile: true
      };

      if (recipient === 'all') {
        io.emit('fileMessage', data);
      } else {
        const recipientSocketId = Object.keys(users).find(
          id => users[id] === recipient
        );

        if (recipientSocketId) {
          io.to(recipientSocketId).emit('fileMessage', data);
          socket.emit('fileMessage', { ...data, isSender: true });
        }
      }
    });

    // Handle room joining
    socket.on('joinRoom', (room) => {
      const username = users[socket.id];
      if (!username || !rooms[room]) return;

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
      io.to(room).emit('roomUpdate', Array.from(rooms[room]));
      socket.emit('roomHistory', messageHistory[room].slice(-50));
      
      console.log(`${username} joined room ${room}`);
    });

    // Handle typing indicators
    socket.on('typing', (data) => {
      socket.broadcast.emit('typing', data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      const username = users[socket.id];
      if (!username) return;

      // Remove user from all rooms
      Object.keys(rooms).forEach(room => {
        if (rooms[room].delete(username)) {
          io.to(room).emit('roomUpdate', Array.from(rooms[room]));
        }
      });

      delete users[socket.id];
      socket.broadcast.emit('userLeft', username);
      io.emit('updateUsers', Object.values(users));
      
      console.log(`${username} left the chat`);
    });

    // Get message history
    socket.on('getHistory', ({ type, name, limit = 20 }) => {
      let history = [];
      if (type === 'room' && messageHistory[name]) {
        history = messageHistory[name].slice(-limit);
      } else if (type === 'private') {
        const conversationKey = name.split('-').sort().join('-');
        history = messageHistory.private[conversationKey]?.slice(-limit) || [];
      }
      socket.emit('history', { type, name, messages: history });
    });
  });
};