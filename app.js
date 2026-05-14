// 1. Global State - Always accessible
let queue = [];
let peerConnection = null;
let socket = null;
let clientId = null;
let bridgeRoomId = '';
let proxyEnabled = false;
let serviceWorkerRegistration = null;
const isLikelyMobileDevice = window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
let deviceRole = isLikelyMobileDevice ? 'provider' : 'receiver';
const FALLBACK_IP = "10.98.169.218"; // Your laptop's hotspot IP
const BRIDGE_KEY_STORAGE = 'data-bridge-room-id';
const PROXY_STATE_STORAGE = 'data-bridge-proxy-enabled';
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

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
}

function headersToObject(headers) {
    const result = {};
    if (!headers) {
        return result;
    }

    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            result[key] = value;
        });
        return result;
    }

    Object.entries(headers).forEach(([key, value]) => {
        result[key] = value;
    });

    return result;
}

function objectToHeaders(headerObject = {}) {
    const headers = new Headers();
    Object.entries(headerObject).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.forEach((entry) => headers.append(key, String(entry)));
            return;
        }

        if (value !== undefined && value !== null) {
            headers.set(key, String(value));
        }
    });

    return headers;
}

function getLocalSocketUrl() {
    const socketUrlInput = document.getElementById('socketUrlInput');
    if (socketUrlInput && socketUrlInput.value.trim()) {
        return socketUrlInput.value.trim();
    }

    return `ws://${FALLBACK_IP}:8080`;
}

function getBridgeSharePayload() {
    return {
        type: 'bridge:pair',
        roomId: getBridgeRoomId(),
        socketUrl: getLocalSocketUrl(),
        clientId,
        generatedAt: new Date().toISOString()
    };
}

function getBridgeShareText() {
    return JSON.stringify(getBridgeSharePayload(), null, 2);
}

function applyBridgeSharePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        logSocket('❌ QR payload missing room or socket URL');
        return;
    }

    const roomId = typeof payload.roomId === 'string' ? payload.roomId.trim() : '';
    const socketUrl = typeof payload.socketUrl === 'string' ? payload.socketUrl.trim() : '';

    if (!roomId || !socketUrl) {
        logSocket('❌ QR payload missing room or socket URL');
        return;
    }

    const bridgeRoomInput = getBridgeRoomInput();
    const socketUrlInput = document.getElementById('socketUrlInput');

    if (bridgeRoomInput) {
        bridgeRoomInput.value = roomId;
        storeBridgeRoomId(roomId);
    }

    if (socketUrlInput) {
        socketUrlInput.value = socketUrl;
    }

    bridgeRoomId = roomId;
    renderBridgeShareInfo();
    setBridgeConnectionState('Bridge: paired', roomId);
    logSocket(`✅ QR imported for room ${roomId}`);
}

async function decodeQrImage(file) {
    if (!file) {
        return;
    }

    if (!window.jsQR) {
        logSocket('❌ QR decoder is unavailable');
        return;
    }

    const imageUrl = URL.createObjectURL(file);
    try {
        const image = new Image();
        const imageLoaded = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
        });

        image.src = imageUrl;
        await imageLoaded;

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas unavailable');
        }

        context.drawImage(image, 0, 0);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.jsQR(imageData.data, imageData.width, imageData.height);

        if (!result || !result.data) {
            logSocket('❌ No QR code detected in the selected image');
            return;
        }

        const payload = JSON.parse(result.data);
        applyBridgeSharePayload(payload);
    } catch (error) {
        console.error('QR decode failed:', error);
        logSocket(`❌ QR import failed: ${error.message}`);
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

function renderBridgeShareInfo() {
    const connectionUrl = document.getElementById('connectionUrl');
    const qrcode = document.getElementById('qrcode');
    const roomId = getBridgeRoomId();
    const socketUrl = getLocalSocketUrl();

    if (connectionUrl) {
        connectionUrl.textContent = roomId
            ? `${socketUrl} | Room: ${roomId}`
            : `${socketUrl} | Room: not set`;
    }

    if (qrcode && window.QRCode) {
        qrcode.innerHTML = '';
        new QRCode(qrcode, {
            text: getBridgeShareText(),
            width: 176,
            height: 176,
            colorDark: '#081018',
            colorLight: '#f5f7fa',
            correctLevel: QRCode.CorrectLevel.M
        });
    }
}

function getProxyStatusText() {
    return proxyEnabled ? 'Proxy: on' : 'Proxy: off';
}

function updateProxyUi() {
    const proxyToggleBtn = document.getElementById('proxyToggleBtn');
    const proxyStatus = document.getElementById('proxyStatus');

    if (proxyToggleBtn) {
        proxyToggleBtn.textContent = proxyEnabled ? 'Proxy ON' : 'Proxy OFF';
    }

    if (proxyStatus) {
        proxyStatus.textContent = `${getProxyStatusText()} | Device role: ${deviceRole}`;
    }
}

function loadStoredProxyState() {
    try {
        return window.localStorage.getItem(PROXY_STATE_STORAGE) === 'true';
    } catch (error) {
        return false;
    }
}

function storeProxyState(enabled) {
    try {
        window.localStorage.setItem(PROXY_STATE_STORAGE, String(enabled));
    } catch (error) {
        // Ignore storage failures.
    }
}

function postToServiceWorker(message) {
    if (!('serviceWorker' in navigator)) {
        console.warn('Service worker unavailable; skipping message:', message?.type);
        return false;
    }

    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(message);
        return true;
    }

    navigator.serviceWorker.ready.then((registration) => {
        registration.active?.postMessage(message);
    }).catch(() => {
        console.warn('Service worker ready promise rejected for message:', message?.type);
    });

    return true;
}

function syncProxyStateToServiceWorker() {
    postToServiceWorker({
        type: 'PROXY_STATE',
        enabled: proxyEnabled,
        clientId
    });
}

function setDeviceRole(role) {
    deviceRole = role === 'provider' ? 'provider' : 'receiver';
    updateProxyUi();
    sendRoleStateToServer();
}

function sendRoleStateToServer() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendSocketEvent('bridge:role', { role: deviceRole });
    }
}

function toggleProxy() {
    proxyEnabled = !proxyEnabled;
    storeProxyState(proxyEnabled);
    updateProxyUi();
    syncProxyStateToServiceWorker();
    sendRoleStateToServer();
    logSocket(proxyEnabled ? 'Proxy enabled' : 'Proxy disabled');
}

function serializeResponseForServiceWorker(response) {
    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        bodyBase64: null
    };
}

async function sendResponseToServiceWorker(requestId, responsePayload) {
    return postToServiceWorker({
        type: 'BRIDGE_PROXY_RESPONSE',
        requestId,
        response: responsePayload
    });
}

async function handleServiceWorkerProxyRequest(payload) {
    if (!proxyEnabled || socket?.readyState !== WebSocket.OPEN) {
        await sendResponseToServiceWorker(payload.requestId, {
            ok: false,
            status: 503,
            statusText: 'Proxy unavailable',
            headers: { 'content-type': 'text/plain' },
            bodyText: 'Bridge proxy is not active.'
        });
        return;
    }

    sendSocketEvent('FETCH_REQUEST', {
        requestId: payload.requestId,
        requesterClientId: clientId,
        request: payload.request,
        sender: deviceRole,
        targetRole: 'provider'
    });
}

async function handleProviderFetchRequest(payload) {
    const request = payload.request || {};
    const requestUrl = request.url;

    if (!requestUrl) {
        sendSocketEvent('FETCH_RESPONSE', {
            requestId: payload.requestId,
            requesterClientId: payload.requesterClientId || payload.clientId,
            response: {
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                headers: { 'content-type': 'text/plain' },
                bodyText: 'Missing URL for fetch request.'
            }
        });
        return;
    }

    try {
        const fetchOptions = {
            method: request.method || 'GET',
            headers: request.headers ? objectToHeaders(request.headers) : undefined,
            mode: request.mode || 'cors',
            credentials: request.credentials || 'include',
            cache: request.cache || 'no-store',
            redirect: request.redirect || 'follow',
            referrer: request.referrer || undefined
        };

        if (request.bodyBase64) {
            fetchOptions.body = base64ToArrayBuffer(request.bodyBase64);
        }

        const response = await fetch(requestUrl, fetchOptions);
        const responseBody = await response.arrayBuffer();

        sendSocketEvent('FETCH_RESPONSE', {
            requestId: payload.requestId,
            requesterClientId: payload.requesterClientId || payload.clientId,
            response: {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: headersToObject(response.headers),
                bodyBase64: arrayBufferToBase64(responseBody)
            }
        });
        logSocket(`🌐 Proxied fetch: ${requestUrl}`);
    } catch (error) {
        console.error('Provider fetch failed:', error);
        sendSocketEvent('FETCH_RESPONSE', {
            requestId: payload.requestId,
            requesterClientId: payload.requesterClientId || payload.clientId,
            response: {
                ok: false,
                status: 502,
                statusText: 'Bad Gateway',
                headers: { 'content-type': 'text/plain' },
                bodyText: error.message || 'Provider fetch failed.'
            }
        });
    }
}

async function handleSocketProxyResponse(payload) {
    if (!payload?.requestId) {
        return;
    }

    const responsePayload = payload.response || {
        ok: false,
        status: 500,
        statusText: 'Bridge response missing',
        headers: { 'content-type': 'text/plain' },
        bodyText: 'Bridge response payload missing.'
    };

    const didSend = await sendResponseToServiceWorker(payload.requestId, responsePayload);
    if (!didSend) {
        logSocket(`⚠️ Bridge response received for request ${payload.requestId}, but no active service worker is available.`);
    }
}

function getBridgeRoomInput() {
    return document.getElementById('bridgeKeyInput');
}

function getBridgeRoomId() {
    const bridgeRoomInput = getBridgeRoomInput();
    return bridgeRoomInput ? bridgeRoomInput.value.trim() : '';
}

function loadStoredBridgeRoomId() {
    try {
        return window.localStorage.getItem(BRIDGE_KEY_STORAGE) || '';
    } catch (error) {
        return '';
    }
}

function storeBridgeRoomId(roomId) {
    try {
        window.localStorage.setItem(BRIDGE_KEY_STORAGE, roomId);
    } catch (error) {
        // Ignore storage failures in private or restricted modes.
    }
}

function syncBridgeStatus(message) {
    const statusLabel = document.getElementById('socketConfigStatus');
    if (statusLabel) {
        statusLabel.textContent = message;
    }
}

function setBridgeConnectionState(state, roomId = '') {
    const bridgeStatus = document.getElementById('bridgeStatus');
    if (bridgeStatus) {
        bridgeStatus.innerText = state;
    }

    syncBridgeStatus(roomId ? `Bridge room: ${roomId}` : 'Enter a bridge key or room ID, then connect.');
}

function sendSocketEvent(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify({
        type,
        clientId,
        roomId: bridgeRoomId,
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
    proxyEnabled = loadStoredProxyState();
    const bridgeRoomInput = getBridgeRoomInput();
    if (bridgeRoomInput) {
        bridgeRoomInput.value = loadStoredBridgeRoomId();
    }
    setBridgeConnectionState('Bridge: idle');
    updateProxyUi();
    registerServiceWorker();
    setupEventListeners();
    renderBridgeShareInfo();
    renderQueue();
    updateNetworkStatus();
});

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        document.getElementById('swStatus').innerText = 'Service worker: unsupported';
        return;
    }

    navigator.serviceWorker.register('./sw.js')
        .then((registration) => {
            serviceWorkerRegistration = registration;
            document.getElementById('swStatus').innerText = 'Service worker: active';
            navigator.serviceWorker.addEventListener('message', async (event) => {
                const data = event.data || {};

                if (data.type === 'BRIDGE_PROXY_REQUEST') {
                    await handleServiceWorkerProxyRequest(data);
                    return;
                }

                if (data.type === 'BRIDGE_PROXY_RESPONSE') {
                    await handleSocketProxyResponse(data);
                    return;
                }
            });

            syncProxyStateToServiceWorker();
        })
        .catch((error) => {
            console.error('Service worker registration failed:', error);
            document.getElementById('swStatus').innerText = 'Service worker: error';
        });
}

// 3. Robust Event Listeners
function setupEventListeners() {
    // Queue management
    const addBtn = document.getElementById('add-to-queue');
    const flushBtn = document.getElementById('flush-queue');
    const refreshCacheBtn = document.getElementById('refreshCacheBtn');
    const scanQrBtn = document.getElementById('scanQrBtn');
    const qrImportInput = document.getElementById('qrImportInput');
    const proxyToggleBtn = document.getElementById('proxyToggleBtn');

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

    if (proxyToggleBtn) {
        proxyToggleBtn.onclick = (e) => {
            e.preventDefault();
            toggleProxy();
        };
    }

    if (scanQrBtn && qrImportInput) {
        scanQrBtn.onclick = (e) => {
            e.preventDefault();
            qrImportInput.value = '';
            qrImportInput.click();
        };

        qrImportInput.addEventListener('change', async () => {
            const file = qrImportInput.files && qrImportInput.files[0];
            if (file) {
                await decodeQrImage(file);
            }
        });
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
            renderBridgeShareInfo();
        };
    }

    const bridgeRoomInput = getBridgeRoomInput();
    if (bridgeRoomInput) {
        bridgeRoomInput.addEventListener('input', () => {
            storeBridgeRoomId(bridgeRoomInput.value.trim());
            renderBridgeShareInfo();
        });
        bridgeRoomInput.addEventListener('change', () => {
            storeBridgeRoomId(bridgeRoomInput.value.trim());
            renderBridgeShareInfo();
        });
    }

    if (socketUrlInput) {
        socketUrlInput.addEventListener('input', renderBridgeShareInfo);
        socketUrlInput.addEventListener('change', renderBridgeShareInfo);
    }

    updateProxyUi();

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
async function connectToSocket(url) {
    console.log(`Attempting to connect to ${url}`);
    const roomId = getBridgeRoomId();

    if (!roomId) {
        setBridgeConnectionState('Bridge: missing key');
        logSocket('❌ Enter a bridge key or room ID before connecting');
        return;
    }

    bridgeRoomId = roomId;
    storeBridgeRoomId(roomId);
    setBridgeConnectionState('Bridge: connecting', roomId);
    renderBridgeShareInfo();
    logSocket(`Connecting to ${url} with bridge room ${roomId}...`);
    
    socket = new WebSocket(url);
    
    socket.onopen = () => {
        console.log("✅ WebSocket connected");
        document.getElementById('bridgeStatus').innerText = "Connected";
        document.getElementById('socketState').innerText = "open";
        setBridgeConnectionState('Bridge: connected', bridgeRoomId);
        logSocket(`✅ Connected to bridge room ${bridgeRoomId}`);

        sendSocketEvent('bridge:join', { roomId: bridgeRoomId });
        sendRoleStateToServer();
        syncProxyStateToServiceWorker();
        
        queue.forEach(item => {
            sendSocketEvent('queue:add', { item });
        });
    };
    
    socket.onmessage = async (event) => {
        console.log("📨 Received:", event.data);
        
        try {
            const data = JSON.parse(event.data);
            if (data.clientId && data.clientId === clientId) {
                return;
            }

            if (data.type === 'bridge:joined') {
                const joinedRoomId = typeof data.roomId === 'string' ? data.roomId : bridgeRoomId;
                setBridgeConnectionState(`Bridge: paired`, joinedRoomId);
                logSocket(`✅ Joined bridge room ${joinedRoomId}`);
                return;
            }

            if (data.type === 'bridge:role-ack') {
                logSocket(`✅ Role acknowledged: ${data.role}`);
                return;
            }

            if (data.type === 'bridge:error') {
                setBridgeConnectionState('Bridge: error', bridgeRoomId);
                logSocket(`❌ ${data.message || 'Bridge error'}`);
                return;
            }

            if (data.type === 'FETCH_REQUEST' && deviceRole === 'provider') {
                await handleProviderFetchRequest(data);
                return;
            }

            if (data.type === 'FETCH_RESPONSE') {
                await handleSocketProxyResponse(data);
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


