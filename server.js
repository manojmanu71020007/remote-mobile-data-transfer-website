const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

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

    ws.on('message', (data) => {
        const message = data.toString();
        console.log(`Received: ${message}`);

        // THE FIX: Broadcast to EVERYONE connected
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
        console.log(`Broadcasting to ${wss.clients.size} clients.`);
    });

    ws.on('close', () => {
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
