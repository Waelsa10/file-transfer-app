const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e8, // 100MB
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
});

const users = new Map();

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

io.on('connection', (socket) => {
  console.log(`[${new Date().toLocaleTimeString()}] Client connected: ${socket.id}`);

  socket.on('register', (email) => {
    if (!users.has(email)) {
      users.set(email, new Set());
    }
    users.get(email).add(socket.id);
    socket.email = email;

    console.log(`[${new Date().toLocaleTimeString()}] ${email} registered with device ${socket.id}`);
    console.log(`Active users: ${users.size}`);
    
    io.emit('user-status', {
      email,
      status: 'online',
      deviceCount: users.get(email).size,
    });
  });

  socket.on('get-users', (email, callback) => {
    try {
      const deviceIds = Array.from(users.get(email) || []);
      const onlineDevices = deviceIds.filter(id => id !== socket.id);
      console.log(`[${new Date().toLocaleTimeString()}] ${email} requested users. Found: ${onlineDevices.length}`);
      callback(onlineDevices);
    } catch (error) {
      console.error('Error in get-users:', error);
      callback([]);
    }
  });

  socket.on('initiate-transfer', (data) => {
    console.log(`[${new Date().toLocaleTimeString()}] Transfer initiated: ${data.fileName} to ${data.targetDeviceId}`);
    io.to(data.targetDeviceId).emit('transfer-request', {
      fromDeviceId: socket.id,
      fileName: data.fileName,
      fileSize: data.fileSize,
    });
  });

  socket.on('accept-transfer', (targetDeviceId) => {
    console.log(`[${new Date().toLocaleTimeString()}] Transfer accepted from ${targetDeviceId}`);
    io.to(targetDeviceId).emit('transfer-accepted', {
      receiverDeviceId: socket.id,
    });
  });

  socket.on('reject-transfer', (targetDeviceId) => {
    console.log(`[${new Date().toLocaleTimeString()}] Transfer rejected by ${targetDeviceId}`);
    io.to(targetDeviceId).emit('transfer-rejected', {
      receiverDeviceId: socket.id,
    });
  });

  socket.on('offer', (data) => {
    console.log(`[${new Date().toLocaleTimeString()}] Offer sent to ${data.to}`);
    io.to(data.to).emit('offer', {
      from: socket.id,
      offer: data.offer,
    });
  });

  socket.on('answer', (data) => {
    console.log(`[${new Date().toLocaleTimeString()}] Answer sent to ${data.to}`);
    io.to(data.to).emit('answer', {
      from: socket.id,
      answer: data.answer,
    });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', {
      from: socket.id,
      candidate: data.candidate,
    });
  });

  socket.on('disconnect', () => {
    if (socket.email) {
      const devices = users.get(socket.email);
      if (devices) {
        devices.delete(socket.id);
        if (devices.size === 0) {
          users.delete(socket.email);
          console.log(`[${new Date().toLocaleTimeString()}] ${socket.email} fully disconnected`);
        }
      }
      io.emit('user-status', {
        email: socket.email,
        status: 'offline',
        deviceCount: users.get(socket.email)?.size || 0,
      });
    }
    console.log(`[${new Date().toLocaleTimeString()}] Client disconnected: ${socket.id}`);
  });

  socket.on('error', (error) => {
    console.error(`Socket error from ${socket.id}:`, error);
  });
});

const PORT = process.env.PORT || 3000;
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   Signaling Server Started             ║`);
  console.log(`╠════════════════════════════════════════╣`);
  console.log(`║ Local IP:     ${localIP.padEnd(22)} ║`);
  console.log(`║ Port:         ${PORT.toString().padEnd(22)} ║`);
  console.log(`║ URL:          http://${localIP}:${PORT}${' '.repeat(21 - localIP.length - PORT.toString().length)} ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});