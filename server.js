const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const PORT = 8080;
const server = http.createServer((req, res) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    
    // Serve static files
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            console.error(`[HTTP] Error reading ${filePath}: ${err.message}`);
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1><p>' + filePath + '</p>', 'utf-8');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server Error: ' + err.message, 'utf-8');
            }
        } else {
            console.log(`[HTTP] Serving ${filePath} (${content.length} bytes)`);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });
const clientsByRoom = new Map();

const bridgeLogSchema = new mongoose.Schema({
    room_id: { type: String, required: true },
    sender: { type: String },
    payload: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now }
});

const BridgeLog = mongoose.model('BridgeLog', bridgeLogSchema);

async function connectMongo() {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
        console.warn('MONGODB_URI is not set. MongoDB logging: disabled');
        return;
    }

    try {
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB Atlas');
    } catch (error) {
        console.error(`❌ MongoDB connection failed: ${error.message}`);
        console.warn('MongoDB logging: disabled');
    }
}

function getRoomClients(roomId) {
    if (!clientsByRoom.has(roomId)) {
        clientsByRoom.set(roomId, new Set());
    }

    return clientsByRoom.get(roomId);
}

function leaveRoom(ws) {
    if (!ws.roomId) {
        return;
    }

    const roomClients = clientsByRoom.get(ws.roomId);
    if (roomClients) {
        roomClients.delete(ws);
        if (roomClients.size === 0) {
            clientsByRoom.delete(ws.roomId);
        }
    }

    ws.roomId = null;
}

function sendJson(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function findRoomClientByRole(roomId, role) {
    const roomClients = clientsByRoom.get(roomId);
    if (!roomClients) {
        return null;
    }

    for (const client of roomClients) {
        if (client.readyState === WebSocket.OPEN && client.role === role) {
            return client;
        }
    }

    return null;
}

function findRoomClientByClientId(roomId, clientId) {
    const roomClients = clientsByRoom.get(roomId);
    if (!roomClients || !clientId) {
        return null;
    }

    for (const client of roomClients) {
        if (client.readyState === WebSocket.OPEN && client.clientId === clientId) {
            return client;
        }
    }

    return null;
}

// Helper to find your IP automatically
const interfaces = os.networkInterfaces();
console.log("--- Server Starting ---");
for (let devName in interfaces) {
    interfaces[devName].forEach((details) => {
        if (details.family === 'IPv4' && !details.internal) {
            console.log(`✅ Reachable at: http://${details.address}:${PORT}`);
        }
    });
}

wss.on('connection', (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] New device connected.`);
    console.log(`Total clients: ${wss.clients.size}`);
    ws.roomId = null;
    ws.roomKey = null;

    ws.on('message', async (data) => {
        const message = data.toString();
        console.log(`Received: ${message}`);

        let payload = null;

        try {
            payload = JSON.parse(message);
        } catch (error) {
            sendJson(ws, {
                type: 'bridge:error',
                message: 'Messages must be JSON objects.',
                timestamp: new Date().toISOString()
            });
            console.warn('Ignored non-JSON websocket message.');
            return;
        }

        if (payload.type === 'bridge:join') {
            const roomId = typeof payload.roomId === 'string' ? payload.roomId.trim() : '';

            if (!roomId) {
                sendJson(ws, {
                    type: 'bridge:error',
                    message: 'A bridge key or room ID is required.',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            leaveRoom(ws);
            ws.roomId = roomId;
            ws.roomKey = roomId;
            ws.clientId = typeof payload.clientId === 'string' ? payload.clientId : null;
            ws.role = typeof payload.role === 'string' ? payload.role : ws.role;
            getRoomClients(roomId).add(ws);

            sendJson(ws, {
                type: 'bridge:joined',
                roomId,
                roomSize: getRoomClients(roomId).size,
                timestamp: new Date().toISOString()
            });

            console.log(`Joined room ${roomId}. Room size: ${getRoomClients(roomId).size}`);
            return;
        }

        if (payload.type === 'bridge:role') {
            const role = typeof payload.role === 'string' ? payload.role.trim() : '';
            if (role) {
                ws.role = role;
                ws.clientId = typeof payload.clientId === 'string' ? payload.clientId : ws.clientId;
                sendJson(ws, {
                    type: 'bridge:role-ack',
                    role,
                    roomId: ws.roomId,
                    timestamp: new Date().toISOString()
                });
                console.log(`Role set to ${role} in room ${ws.roomId}.`);
            }
            return;
        }

        if (!ws.roomId) {
            sendJson(ws, {
                type: 'bridge:error',
                message: 'Join a bridge room before sending data.',
                timestamp: new Date().toISOString()
            });
            console.warn('Rejected message from unpaired client.');
            return;
        }

        if (mongoose.connection.readyState === 1) {
            try {
                const newLog = new BridgeLog({
                    room_id: ws.roomKey,
                    sender: 'mobile_device',
                    payload
                });
                await newLog.save();
            } catch (error) {
                console.error(`⚠️ Failed to save BridgeLog: ${error.message}`);
            }
        } else {
            console.warn('MongoDB not connected. Skipping BridgeLog save.');
        }

        if (payload.type === 'FETCH_REQUEST') {
            const provider = findRoomClientByRole(ws.roomId, 'provider');
            if (!provider) {
                sendJson(ws, {
                    type: 'FETCH_RESPONSE',
                    requestId: payload.requestId,
                    requesterClientId: payload.requesterClientId || ws.clientId || payload.clientId || null,
                    response: {
                        ok: false,
                        status: 503,
                        statusText: 'No provider available',
                        headers: { 'content-type': 'text/plain' },
                        bodyText: 'No provider device is available in this room.'
                    }
                });
                console.warn(`No provider found in room ${ws.roomId} for FETCH_REQUEST.`);
                return;
            }

            provider.send(message);
            console.log(`Forwarded FETCH_REQUEST to provider in room ${ws.roomId}.`);
            return;
        }

        if (payload.type === 'FETCH_RESPONSE') {
            const requesterClientId = payload.requesterClientId || payload.targetClientId || payload.clientId || null;
            const requester = findRoomClientByClientId(ws.roomId, requesterClientId);

            if (requester) {
                requester.send(message);
                console.log(`Delivered FETCH_RESPONSE to ${requesterClientId} in room ${ws.roomId}.`);
                return;
            }

            console.warn(`No requester found for FETCH_RESPONSE in room ${ws.roomId}; broadcasting to room.`);
        }

        // Broadcast only within the joined room.
        getRoomClients(ws.roomId).forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
        console.log(`Broadcasting to room ${ws.roomId} (${getRoomClients(ws.roomId).size} clients).`);
    });

    ws.on('close', () => {
        leaveRoom(ws);
        console.log("Device disconnected.");
    });
});

// Handle the "Address already in use" error gracefully
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌ PORT ${PORT} IS BUSY! Kill the other terminal or restart VS Code.`);
        process.exit(1);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Bridge Server live on port ${PORT}`);
});

connectMongo();
