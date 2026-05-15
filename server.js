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
    dataBytes: { type: Number, default: 0 },
    unread: { type: Boolean, default: true },
    deliveredAt: { type: Date, default: null },
    timestamp: { type: Date, default: Date.now }
});

const BridgeLog = mongoose.model('BridgeLog', bridgeLogSchema);

const dataUsageSchema = new mongoose.Schema({
    roomId: { type: String, required: true },
    bytes: { type: Number, required: true },
    kb: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});

const DataUsage = mongoose.model('DataUsage', dataUsageSchema);

const offlineMessageSchema = new mongoose.Schema({
    room_id: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    requesterClientId: { type: String, default: null },
    sender: { type: String, default: 'mobile_device' },
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

const OfflineMessage = mongoose.model('OfflineMessage', offlineMessageSchema);

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

function formatBytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) {
        return '0 B';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function getTotalDataTransferredKB(roomId) {
    if (mongoose.connection.readyState !== 1) {
        return 0;
    }

    try {
        const result = await DataUsage.aggregate([
            { $match: { roomId } },
            { $group: { _id: null, totalKB: { $sum: '$kb' } } }
        ]);
        return result.length > 0 ? result[0].totalKB : 0;
    } catch (error) {
        console.error(`⚠️ Failed to get total data for room ${roomId}: ${error.message}`);
        return 0;
    }
}

function calculateDataBytes(payload) {
    if (!payload) {
        return 0;
    }

    if (payload.type === 'FETCH_RESPONSE' && payload.response) {
        const res = payload.response;
        if (res.bodyBase64) {
            return Math.floor((res.bodyBase64.length * 3) / 4); // Approximate bytes from base64
        }
        if (res.bodyText) {
            return Buffer.byteLength(res.bodyText, 'utf8');
        }
    }

    if (payload.type === 'FETCH_REQUEST' && payload.request && payload.request.bodyBase64) {
        return Math.floor((payload.request.bodyBase64.length * 3) / 4);
    }

    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch (error) {
        return 0;
    }
}

async function persistPendingMessage(roomId, payload, requesterClientId, senderRole) {
    if (mongoose.connection.readyState !== 1) {
        return;
    }

    try {
        await OfflineMessage.create({
            room_id: roomId,
            payload,
            requesterClientId: requesterClientId || (payload.requesterClientId || payload.clientId || null),
            sender: senderRole || payload.sender || 'mobile_device',
            status: 'pending'
        });
    } catch (error) {
        console.error(`⚠️ Failed to persist pending message: ${error.message}`);
    }
}

async function handleSyncPull(ws) {
    if (mongoose.connection.readyState !== 1) {
        sendJson(ws, {
            type: 'SYNC_RESPONSE',
            items: [],
            error: 'MongoDB unavailable',
            timestamp: new Date().toISOString()
        });
        return;
    }

    try {
        const pendingItems = await OfflineMessage.find({ room_id: ws.roomId, status: 'pending' }).sort({ createdAt: 1 }).lean();
        if (pendingItems.length === 0) {
            sendJson(ws, {
                type: 'SYNC_RESPONSE',
                items: [],
                timestamp: new Date().toISOString()
            });
            return;
        }

        sendJson(ws, {
            type: 'SYNC_RESPONSE',
            items: pendingItems.map(item => ({
                ...item,
                _id: undefined,
                room_id: undefined
            })),
            timestamp: new Date().toISOString()
        });

        await OfflineMessage.deleteMany({ _id: { $in: pendingItems.map((item) => item._id) } });
        if (ws.role === 'receiver') {
            console.log(`[Server] ${pendingItems.length} messages recovered from database for Laptop.`);
        } else {
            console.log(`Sent ${pendingItems.length} pending message(s) from MongoDB to ${ws.clientId} in room ${ws.roomId}.`);
        }
    } catch (error) {
        console.error(`⚠️ Failed to service SYNC_PULL: ${error.message}`);
        sendJson(ws, {
            type: 'SYNC_RESPONSE',
            items: [],
            error: 'Sync failed',
            timestamp: new Date().toISOString()
        });
    }
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

        if (payload.type === 'SYNC_REQUEST' || payload.type === 'SYNC_PULL') {
            await handleSyncPull(ws);
            return;
        }

        if (payload.type === 'GET_TOTAL_DATA') {
            const totalKB = await getTotalDataTransferredKB(ws.roomId);
            sendJson(ws, {
                type: 'TOTAL_DATA_RESPONSE',
                totalKB,
                roomId: ws.roomId,
                timestamp: new Date().toISOString()
            });
            return;
        }

        if (mongoose.connection.readyState === 1) {
            try {
                const dataBytes = calculateDataBytes(payload);
                console.log('Attempting to save to MongoDB:', dataBytes);
                const readableSize = formatBytes(dataBytes);
                const isPersistedMessage = payload.type !== 'bridge:join' && payload.type !== 'bridge:role' && payload.type !== 'bridge:role-ack' && payload.type !== 'bridge:joined' && payload.type !== 'bridge:error' && payload.type !== 'SYNC_RESPONSE' && payload.type !== 'SYNC_REQUEST' && payload.type !== 'SYNC_PULL';
                const newLog = new BridgeLog({
                    room_id: ws.roomKey,
                    sender: 'mobile_device',
                    payload,
                    dataBytes,
                    unread: isPersistedMessage
                });
                await newLog.save();

                const dataUsageEntry = new DataUsage({
                    roomId: ws.roomKey,
                    bytes: dataBytes,
                    kb: dataBytes / 1024
                });
                await dataUsageEntry.save();

                if ((payload.type === 'queue:add' || payload.type === 'queue:flush') && ws.role === 'provider') {
                    const usageEvent = {
                        type: 'DATA_USAGE',
                        roomId: ws.roomId,
                        bytes: dataBytes,
                        kb: dataBytes / 1024,
                        timestamp: new Date().toISOString()
                    };
                    const roomClients = getRoomClients(ws.roomId);
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(usageEvent));
                        }
                    });
                }
            } catch (error) {
                console.error(`⚠️ Failed to save BridgeLog or DataUsage: ${error.message}`);
            }
        } else {
            console.warn('MongoDB not connected. Skipping BridgeLog save.');
        }

        if (payload.type === 'FETCH_REQUEST') {
            const provider = findRoomClientByRole(ws.roomId, 'provider');
            if (!provider) {
                console.log(`No provider found in room ${ws.roomId}. Persisting pending FETCH_REQUEST.`);
                if (mongoose.connection.readyState === 1) {
                    await OfflineMessage.create({
                        room_id: ws.roomId,
                        payload,
                        requesterClientId: payload.requesterClientId || ws.clientId || payload.clientId || null,
                        sender: ws.role || 'mobile_device',
                        status: 'pending'
                    });
                }
                return;
            }

            console.log(`Routing FETCH_REQUEST from ${ws.clientId} to provider ${provider.clientId} in room ${ws.roomId}`);
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

            console.log(`No requester found for FETCH_RESPONSE in room ${ws.roomId}. Persisting pending response.`);
            await persistPendingMessage(ws.roomId, payload, requesterClientId, ws.role);
            return;
        }

        const roomClients = getRoomClients(ws.roomId);
        const otherClients = Array.from(roomClients).filter((client) => client !== ws && client.readyState === WebSocket.OPEN);
        const excludedControlTypes = ['bridge:join', 'bridge:role', 'bridge:role-ack', 'bridge:joined', 'bridge:error', 'SYNC_RESPONSE', 'SYNC_REQUEST', 'SYNC_PULL'];

        if (otherClients.length === 0 && !excludedControlTypes.includes(payload.type)) {
            console.log(`No target available in room ${ws.roomId}; persisting pending payload of type ${payload.type}.`);
            await persistPendingMessage(ws.roomId, payload, payload.requesterClientId || ws.clientId, ws.role);
            return;
        }

        otherClients.forEach((client) => {
            client.send(message);
        });
        console.log(`Broadcasting to room ${ws.roomId} (${otherClients.length} remote clients).`);
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
