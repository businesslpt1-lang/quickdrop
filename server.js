const express = require('express');
const multer = require('multer');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 1024 * 1024 * 1024 * 2; // 2GB hard cap (user's files are usually <1GB)
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24h auto-cleanup

const genRoomCode = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 6);
const genFileId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 12);

if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// In-memory room registry: { code: { createdAt, files: { fileId: {name, size, mime, storedAt} } } }
const rooms = new Map();

function roomDir(code) {
  return path.join(UPLOAD_ROOT, code);
}

function isValidRoomCode(code) {
  return typeof code === 'string' && /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/.test(code);
}

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { createdAt: Date.now(), files: new Map() };
    rooms.set(code, room);
    fs.mkdirSync(roomDir(code), { recursive: true });
  }
  return room;
}

function sanitizeFilename(name) {
  const base = path.basename(name).replace(/[/\\?%*:|"<>]/g, '_');
  return base.slice(0, 255) || 'file';
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return val.toFixed(1) + ' ' + units[i];
}

function publicFileList(room) {
  return Array.from(room.files.entries()).map(([id, f]) => ({
    id,
    name: f.name,
    size: f.size,
    sizeHuman: humanSize(f.size),
    mime: f.mime,
    uploadedAt: f.storedAt
  })).sort((a, b) => a.uploadedAt - b.uploadedAt);
}

// --- Multer storage: files go into the room's folder under a random id-prefixed name ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const code = req.params.code;
    if (!isValidRoomCode(code)) return cb(new Error('Invalid room code'));
    getOrCreateRoom(code);
    cb(null, roomDir(code));
  },
  filename: (req, file, cb) => {
    const id = genFileId();
    file._fileId = id;
    const safeName = sanitizeFilename(file.originalname);
    cb(null, `${id}__${safeName}`);
  }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create a new room
app.post('/api/room', (req, res) => {
  const code = genRoomCode();
  getOrCreateRoom(code);
  res.json({ code });
});

// List files in a room
app.get('/api/room/:code/files', (req, res) => {
  const { code } = req.params;
  if (!isValidRoomCode(code)) return res.status(400).json({ error: 'Invalid room code' });
  const room = rooms.get(code);
  if (!room) return res.json({ files: [] });
  res.json({ files: publicFileList(room) });
});

// Upload one or more files to a room
app.post('/api/room/:code/upload', (req, res, next) => {
  const { code } = req.params;
  if (!isValidRoomCode(code)) return res.status(400).json({ error: 'Invalid room code' });
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 2GB)' });
      return res.status(400).json({ error: err.message });
    }
    const room = getOrCreateRoom(code);
    const added = [];
    for (const file of req.files || []) {
      const entry = {
        name: file.originalname,
        size: file.size,
        mime: file.mimetype || 'application/octet-stream',
        storedAt: Date.now(),
        diskPath: file.path
      };
      room.files.set(file._fileId, entry);
      added.push({ id: file._fileId, name: entry.name, size: entry.size, sizeHuman: humanSize(entry.size), mime: entry.mime, uploadedAt: entry.storedAt });
    }
    io.to(code).emit('files-added', added);
    res.json({ files: added });
  });
});

// Download a file
app.get('/api/room/:code/download/:fileId', (req, res) => {
  const { code, fileId } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).send('Room not found or expired');
  const file = room.files.get(fileId);
  if (!file) return res.status(404).send('File not found');
  if (!fs.existsSync(file.diskPath)) return res.status(404).send('File no longer on disk');
  res.download(file.diskPath, file.name);
});

// Download all files in a room as a single zip
app.get('/api/room/:code/download-all', (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room || room.files.size === 0) return res.status(404).send('No files to download');

  res.attachment(`quickdrop-${code}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).end());
  archive.pipe(res);

  const usedNames = new Set();
  for (const file of room.files.values()) {
    if (!fs.existsSync(file.diskPath)) continue;
    let name = file.name;
    let i = 1;
    while (usedNames.has(name)) {
      const ext = path.extname(file.name);
      const base = path.basename(file.name, ext);
      name = `${base} (${i++})${ext}`;
    }
    usedNames.add(name);
    archive.file(file.diskPath, { name });
  }
  archive.finalize();
});

// Delete a file (either device can remove it)
app.delete('/api/room/:code/files/:fileId', (req, res) => {
  const { code, fileId } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const file = room.files.get(fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  fs.unlink(file.diskPath, () => {});
  room.files.delete(fileId);
  io.to(code).emit('file-removed', { id: fileId });
  res.json({ ok: true });
});

// Delete all files in a room
app.delete('/api/room/:code/files', (req, res) => {
  const { code } = req.params;
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const ids = Array.from(room.files.keys());
  for (const file of room.files.values()) fs.unlink(file.diskPath, () => {});
  room.files.clear();
  io.to(code).emit('files-cleared', { ids });
  res.json({ ok: true, removed: ids.length });
});

// Room page (client reads the code from the URL)
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

io.on('connection', (socket) => {
  socket.on('join', (code) => {
    if (isValidRoomCode(code)) socket.join(code);
  });
});

// --- Auto-cleanup expired rooms ---
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      fs.rm(roomDir(code), { recursive: true, force: true }, () => {});
      rooms.delete(code);
      io.to(code).emit('room-expired');
    }
  }
}, 60 * 60 * 1000); // check hourly

server.listen(PORT, () => {
  console.log(`File transfer app running on http://localhost:${PORT}`);
});
