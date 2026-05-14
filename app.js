// 1. Global State - Always accessible
let queue = [];
let peerConnection = null;
let socket = null;
let clientId = null;
const FALLBACK_IP = "10.98.169.218"; // Your laptop's hotspot IP
const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

function createClientId() {
    if (window.crypto && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getLocalSocketUrl() {
    const socketUrlInput = document.getElementById('socketUrlInput');
    if (socketUrlInput && socketUrlInput.value.trim()) {
        return socketUrlInput.value.trim();
    }

    return `ws://${FALLBACK_IP}:8080`;
}

function sendSocketEvent(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify({
        type,
        clientId,
        timestamp: new Date().toISOString(),
        ...payload
    }));
}

function applyQueueAdd(item, sourceLabel) {
    queue.push(item);
    renderQueue();
    logSocket(`[${sourceLabel}] queued: ${getQueueNote(item)}`);
}

function applyQueueFlush(sourceLabel) {
    queue = [];
    renderQueue();
    logSocket(`[${sourceLabel}] queue flushed`);
}

function getQueueNote(item) {
    if (!item) {
        return '';
    }

    if (typeof item === 'string') {
        return item;
    }

    return item.note ?? item.message ?? item.value ?? JSON.stringify(item);
}

function getQueueTimestamp(item) {
    if (!item) {
        return '';
    }

    if (typeof item === 'string') {
        return '';
    }

    return item.timestamp ?? item.time ?? '';
}

// 2. Initialize UI immediately
window.addEventListener('DOMContentLoaded', () => {
    console.log("App initialized. UI Unlocked.");
    clientId = createClientId();
    setupEventListeners();
    renderQueue();
    updateNetworkStatus();
});

// 3. Robust Event Listeners
function setupEventListeners() {
    // Queue management
    const addBtn = document.getElementById('add-to-queue');
    const flushBtn = document.getElementById('flush-queue');
    const refreshCacheBtn = document.getElementById('refreshCacheBtn');

    if (addBtn) {
        addBtn.onclick = (e) => {
            e.preventDefault();
            const payloadInput = document.getElementById('payload-input');
            const val = payloadInput.value || "Test Data";
            const item = {
                id: `${clientId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                note: val,
                timestamp: new Date().toLocaleString(),
                sender: 'mobile-client',
                clientId
            };

            payloadInput.value = "";
            applyQueueAdd(item, 'local');
            sendSocketEvent('queue:add', { item });
            console.log("Added to local queue:", val);
        };
    }

    if (flushBtn) {
        flushBtn.onclick = (e) => {
            e.preventDefault();
            applyQueueFlush('local');
            sendSocketEvent('queue:flush');
            console.log("Queue flushed");
        };
    }

    if (refreshCacheBtn) {
        refreshCacheBtn.onclick = () => {
            if ('caches' in window) {
                caches.keys().then(names => {
                    names.forEach(name => caches.delete(name));
                    console.log("Cache refreshed");
                    logSocket("Cache cleared");
                });
            }
        };
    }

    // WebRTC controls
    const createOfferBtn = document.getElementById('createOfferBtn');
    const acceptOfferBtn = document.getElementById('acceptOfferBtn');
    const copySignalBtn = document.getElementById('copySignalBtn');
    const resetPeerBtn = document.getElementById('resetPeerBtn');

    if (createOfferBtn) {
        createOfferBtn.onclick = createWebRTCOffer;
    }
    if (acceptOfferBtn) {
        acceptOfferBtn.onclick = acceptWebRTCOffer;
    }
    if (copySignalBtn) {
        copySignalBtn.onclick = copyLocalSignal;
    }
    if (resetPeerBtn) {
        resetPeerBtn.onclick = resetPeerConnection;
    }

    // Socket controls
    const socketBtn = document.getElementById('local-socket-btn');
    const disconnectBtn = document.getElementById('disconnectSocketBtn');
    const seedSocketBtn = document.getElementById('seedSocketBtn');
    const socketUrlInput = document.getElementById('socketUrlInput');

    if (socketBtn) {
        socketBtn.onclick = (e) => {
            e.preventDefault();
            const url = socketUrlInput.value || `ws://${FALLBACK_IP}:8080`;
            connectToSocket(url);
        };
    }
    if (disconnectBtn) {
        disconnectBtn.onclick = disconnectSocket;
    }
    if (seedSocketBtn) {
        seedSocketBtn.onclick = () => {
            socketUrlInput.value = getLocalSocketUrl();
            logSocket("Hotspot defaults set: " + socketUrlInput.value);
        };
    }

    // Mode switching (tabs)
    const modeButtons = document.querySelectorAll('.mode-button');
    modeButtons.forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            const mode = btn.dataset.mode;
            switchMode(mode);
        };
    });
}

// 4. Instant UI Rendering
function renderQueue() {
    const container = document.getElementById('offline-queue-list');
    const countLabel = document.getElementById('queued-count');
    
    if (!container) return;

    container.innerHTML = "";
    if (countLabel) countLabel.innerText = queue.length;

    queue.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = "queue-item";
        card.innerHTML = `
            <div>
                <h3>note: ${escapeHtml(String(getQueueNote(item)).substring(0, 50))}</h3>
                <p>${escapeHtml(String(getQueueTimestamp(item)))}</p>
            </div>
            <div class="queue-meta" style="color:#4ade80;">queued</div>
        `;
        container.appendChild(card);
    });
}

// 5. Mode/Tab Switching
function switchMode(mode) {
    // Update button states
    document.querySelectorAll('.mode-button').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.mode === mode);
        btn.setAttribute('aria-selected', btn.dataset.mode === mode);
    });

    // Show/hide panels
    document.querySelectorAll('.bridge-section').forEach(section => {
        section.hidden = section.dataset.panel !== mode;
    });

    console.log("Switched to mode:", mode);
}

// 6. WebRTC Implementation
async function createWebRTCOffer() {
    try {
        const config = { iceServers: STUN_SERVERS };
        peerConnection = new RTCPeerConnection(config);

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("ICE candidate:", event.candidate);
            }
        };

        peerConnection.onconnectionstatechange = () => {
            console.log("Peer connection state:", peerConnection.connectionState);
            updatePeerState();
        };

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        const output = JSON.stringify(offer, null, 2);
        document.getElementById('signalingOutput').value = output;
        document.getElementById('peerState').innerText = "offering";

        logSocket("WebRTC offer created");
        console.log("Offer created:", offer);
    } catch (error) {
        console.error("Error creating offer:", error);
        logSocket("❌ Error creating offer: " + error.message);
    }
}

async function acceptWebRTCOffer() {
    try {
        const remoteInput = document.getElementById('signalingInput').value;
        if (!remoteInput) {
            logSocket("❌ No remote offer provided");
            return;
        }

        const offer = JSON.parse(remoteInput);
        
        if (!peerConnection) {
            const config = { iceServers: STUN_SERVERS };
            peerConnection = new RTCPeerConnection(config);
            
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log("ICE candidate:", event.candidate);
                }
            };

            peerConnection.onconnectionstatechange = () => {
                console.log("Peer connection state:", peerConnection.connectionState);
                updatePeerState();
            };
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        const output = JSON.stringify(answer, null, 2);
        document.getElementById('signalingOutput').value = output;
        document.getElementById('peerState').innerText = "answering";

        logSocket("WebRTC answer created");
        console.log("Answer created:", answer);
    } catch (error) {
        console.error("Error accepting offer:", error);
        logSocket("❌ Error accepting offer: " + error.message);
    }
}

function resetPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    document.getElementById('signalingOutput').value = "";
    document.getElementById('signalingInput').value = "";
    document.getElementById('peerState').innerText = "new";
    logSocket("Peer connection reset");
}

function updatePeerState() {
    if (peerConnection) {
        document.getElementById('peerState').innerText = peerConnection.connectionState || 'unknown';
    }
}

function copyLocalSignal() {
    const text = document.getElementById('signalingOutput').value;
    if (!text) {
        logSocket("No signal to copy");
        return;
    }
    
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            logSocket("✅ Signal copied to clipboard");
        }).catch(err => {
            console.error("Copy failed:", err);
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    // Fallback for browsers without clipboard API
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        logSocket("✅ Signal copied (fallback)");
    } catch (err) {
        console.error("Fallback copy failed:", err);
        logSocket("❌ Copy failed - manually select and copy the text");
    }
}

// 7. WebSocket Connection
function connectToSocket(url) {
    console.log(`Attempting to connect to ${url}`);
    logSocket(`Connecting to ${url}...`);
    
    socket = new WebSocket(url);
    
    socket.onopen = () => {
        console.log("✅ WebSocket connected");
        document.getElementById('bridgeStatus').innerText = "Connected";
        document.getElementById('socketState').innerText = "open";
        logSocket("✅ Connected");
        
        queue.forEach(item => {
            sendSocketEvent('queue:add', { item });
        });
    };
    
    socket.onmessage = (event) => {
        console.log("📨 Received:", event.data);
        
        try {
            const data = JSON.parse(event.data);
            if (data.clientId && data.clientId === clientId) {
                return;
            }

            if (data.type === 'queue:add' && data.item) {
                applyQueueAdd(data.item, 'remote');
                return;
            }

            if (data.type === 'queue:flush') {
                applyQueueFlush('remote');
                return;
            }

            logSocket("📨 Received: " + event.data.substring(0, 100));
        } catch(e) {
            console.error("Failed to parse message:", e);
            logSocket("📨 Received: " + event.data.substring(0, 100));
        }
    };
    
    socket.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
        document.getElementById('bridgeStatus').innerText = "Error";
        logSocket("❌ Error: " + error);
    };
    
    socket.onclose = () => {
        console.log("🔌 WebSocket closed");
        document.getElementById('bridgeStatus').innerText = "Disconnected";
        document.getElementById('socketState').innerText = "closed";
        logSocket("Connection closed");
    };
}

function disconnectSocket() {
    if (socket) {
        socket.close();
        socket = null;
    }
    document.getElementById('bridgeStatus').innerText = "Disconnected";
    document.getElementById('socketState').innerText = "closed";
    logSocket("Disconnected");
}

// 8. Socket logging
function logSocket(message) {
    const logArea = document.getElementById('socketLog');
    if (logArea) {
        const timestamp = new Date().toLocaleTimeString();
        logArea.value += `[${timestamp}] ${message}\n`;
        logArea.scrollTop = logArea.scrollHeight;
    }
}

// 9. Network status
function updateNetworkStatus() {
    if (navigator.onLine) {
        document.getElementById('netStatus').innerText = "Network: online";
        document.getElementById('offlineState').innerText = "false";
    } else {
        document.getElementById('netStatus').innerText = "Network: offline";
        document.getElementById('offlineState').innerText = "true";
    }
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(() => {
            document.getElementById('swStatus').innerText = "Service worker: active";
        });
    }
}

// 10. Utility function
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}


