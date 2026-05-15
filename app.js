// 1. Global State - Always accessible
let queue = [];
let peerConnection = null;
let socket = null;
let clientId = null;
let bridgeRoomId = '';
let proxyEnabled = false;
let serviceWorkerRegistration = null;
let lastSocketUrl = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
let reconnectInProgress = false;
const isLikelyMobileDevice = window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
let deviceRole = isLikelyMobileDevice ? 'provider' : 'receiver';
const FALLBACK_IP = "10.98.169.218"; // Your laptop's hotspot IP
const BRIDGE_KEY_STORAGE = 'data-bridge-room-id';
const PROXY_STATE_STORAGE = 'data-bridge-proxy-enabled';
const OFFLINE_QUEUE_STORAGE = 'data-bridge-offline-queue';
const RECONNECT_ATTEMPTS_STORAGE = 'data-bridge-reconnect-attempts';
let displayRequestId = null;
let totalDataTransferredBytes = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 2000; // 2 seconds
const MAX_RECONNECT_DELAY = 30000; // 30 seconds
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

function formatKilobytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) {
        return '0 KB';
    }
    const value = bytes / 1024;
    if (value > 0 && value < 0.01) {
        return '0.01 KB';
    }
    return `${value.toFixed(2)} KB`;
}

function updateTotalDataTransferredUI() {
    const el = document.getElementById('total-data-transferred');
    if (el) {
        el.innerText = formatKilobytes(totalDataTransferredBytes);
    }
}

function requestTotalDataFromDB() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendSocketEvent('GET_TOTAL_DATA');
    }
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

function updateProxyUi() {
    const roleToggleBtn = document.getElementById('roleToggleBtn');
    const proxyStatus = document.getElementById('proxyStatus');

    if (roleToggleBtn) {
        roleToggleBtn.textContent = deviceRole === 'provider' ? 'Provider Mode' : 'Receiver Mode';
    }

    if (proxyStatus) {
        proxyStatus.textContent = `Proxy: ${proxyEnabled ? 'on' : 'off'} | Device role: ${deviceRole}`;
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

function toggleRole() {
    deviceRole = deviceRole === 'provider' ? 'receiver' : 'provider';
    proxyEnabled = (deviceRole === 'receiver');
    storeProxyState(proxyEnabled);
    updateProxyUi();
    syncProxyStateToServiceWorker();
    sendRoleStateToServer();
    logSocket(`Switched to ${deviceRole} mode`);
}

function fetchViaProxy() {
    const url = document.getElementById('proxyUrlInput').value.trim();
    if (!url) {
        logSocket('❌ Enter a URL to fetch');
        return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        logSocket('❌ Socket not connected');
        return;
    }
    displayRequestId = `display-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request = { url, method: 'GET', headers: {}, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow', referrer: '' };
    sendSocketEvent('FETCH_REQUEST', { requestId: displayRequestId, requesterClientId: clientId, request, sender: deviceRole, targetRole: 'provider' });
    logSocket(`📤 Sent display fetch request for ${url}`);
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

    if (payload.requestId === displayRequestId) {
        // Display in iframe
        const iframe = document.getElementById('proxyIframe');
        if (iframe && responsePayload.ok) {
            const contentType = responsePayload.headers['content-type'] || 'text/html';
            let content = '';
            if (responsePayload.bodyBase64) {
                const bytes = base64ToArrayBuffer(responsePayload.bodyBase64);
                if (contentType.startsWith('text/')) {
                    content = new TextDecoder().decode(bytes);
                } else {
                    // For binary, create a blob URL
                    const blob = new Blob([bytes], { type: contentType });
                    content = `<iframe src="${URL.createObjectURL(blob)}" style="width:100%;height:100%;border:none;"></iframe>`;
                }
            } else if (responsePayload.bodyText) {
                content = responsePayload.bodyText;
            }
            iframe.srcdoc = content;
            logSocket(`✅ Displayed proxied content (${responsePayload.status})`);
        } else {
            logSocket(`❌ Failed to display proxied content (${responsePayload.status})`);
        }
        displayRequestId = null;
        return;
    }

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

// Offline queue management for persistent storage
function getOfflineQueue() {
    try {
        const stored = window.localStorage.getItem(OFFLINE_QUEUE_STORAGE);
        return stored ? JSON.parse(stored) : [];
    } catch (error) {
        console.error("Failed to retrieve offline queue:", error);
        return [];
    }
}

function saveOfflineQueue(offlineQueue) {
    try {
        window.localStorage.setItem(OFFLINE_QUEUE_STORAGE, JSON.stringify(offlineQueue));
    } catch (error) {
        console.error("Failed to save offline queue:", error);
    }
}

function addToOfflineQueue(eventType, eventData) {
    const offlineQueue = getOfflineQueue();
    offlineQueue.push({
        type: eventType,
        data: eventData,
        timestamp: Date.now(),
        clientId: clientId,
        roomId: bridgeRoomId
    });
    saveOfflineQueue(offlineQueue);
    logSocket(`📦 Queued offline (${offlineQueue.length} items): ${eventType}`);
    updateOfflineQueueStatus();
    return offlineQueue.length;
}

function flushOfflineQueue() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        logSocket("⚠️ Cannot flush queue - socket not connected");
        return;
    }

    const offlineQueue = getOfflineQueue();
    if (offlineQueue.length === 0) {
        logSocket("✅ Offline queue is empty");
        return;
    }

    logSocket(`📤 Flushing ${offlineQueue.length} queued items...`);
    let successCount = 0;
    
    offlineQueue.forEach((item, index) => {
        try {
            setTimeout(() => {
                logSocket(`📤 Sending queued ${item.type} (${index + 1}/${offlineQueue.length})`);
                sendSocketEvent(item.type, item.data);
                successCount++;
                if (successCount === offlineQueue.length) {
                    setTimeout(() => {
                        window.localStorage.removeItem(OFFLINE_QUEUE_STORAGE);
                        updateOfflineQueueStatus();
                        logSocket(`✅ Flushed ${successCount}/${offlineQueue.length} items`);
                    }, 500);
                }
            }, index * 200); // Increased delay to 200ms for better logging
        } catch (error) {
            console.error(`Failed to send queued item ${index}:`, error);
        }
    });
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
    const message = {
        type,
        clientId,
        roomId: bridgeRoomId,
        timestamp: new Date().toISOString(),
        ...payload
    };

    // If socket is not connected, queue the message for later delivery
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (type !== 'bridge:join') { // Don't queue join events
            addToOfflineQueue(type, payload);
        }

        if (navigator.onLine && lastSocketUrl) {
            tryAutoReconnect();
        }

        return;
    }

    socket.send(JSON.stringify(message));
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
    updateOfflineQueueStatus();
    updateTotalDataTransferredUI();
    
    window.addEventListener('online', () => {
        logSocket('🔌 Network returned: attempting reconnect if needed');
        updateNetworkStatus();
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            tryAutoReconnect();
        }
    });

    window.addEventListener('offline', () => {
        logSocket('📴 Network offline. Offline queue will persist until reconnect.');
        updateNetworkStatus();
    });

    // Update offline queue status every 5 seconds
    setInterval(updateOfflineQueueStatus, 5000);
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
    const proxyToggleBtn = document.getElementById('roleToggleBtn');

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
            const itemsToFlush = [...queue];
            if (itemsToFlush.length > 0) {
                sendSocketEvent('queue:flush', { items: itemsToFlush });
            } else {
                sendSocketEvent('queue:flush');
            }
            applyQueueFlush('local');
            console.log(`Queue flushed (${itemsToFlush.length} items)`);
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
            toggleRole();
        };
    }

    const fetchProxyBtn = document.getElementById('fetchProxyBtn');
    if (fetchProxyBtn) {
        fetchProxyBtn.onclick = (e) => {
            e.preventDefault();
            fetchViaProxy();
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
    const flushOfflineQueueBtn = document.getElementById('flushOfflineQueueBtn');
    if (flushOfflineQueueBtn) {
        flushOfflineQueueBtn.onclick = flushOfflineQueue;
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

// 7. WebSocket Connection with Auto-Reconnect & Offline Queue
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
    reconnectAttempts = 0;
    lastSocketUrl = url;
    reconnectInProgress = false;
    
    socket = new WebSocket(url);
    
    socket.onopen = () => {
        console.log("✅ WebSocket connected");
        document.getElementById('bridgeStatus').innerText = "Connected";
        document.getElementById('socketState').innerText = "open";
        setBridgeConnectionState('Bridge: connected', bridgeRoomId);
        logSocket(`✅ Connected to bridge room ${bridgeRoomId}`);
        reconnectAttempts = 0; // Reset on successful connection
        reconnectInProgress = false;

        sendSocketEvent('bridge:join', { roomId: bridgeRoomId });
        sendRoleStateToServer();
        syncProxyStateToServiceWorker();
        
        queue.forEach(item => {
            sendSocketEvent('queue:add', { item });
        });

        // Flush offline queue when reconnected
        flushOfflineQueue();

        // Request total data from DB
        requestTotalDataFromDB();

        // Request unread sync items from server
        if (deviceRole === 'receiver') {
            sendSocketEvent('SYNC_PULL', {
                requesterClientId: clientId,
                sender: deviceRole,
                targetRole: 'provider'
            });
            logSocket('📡 Sent SYNC_PULL to server');
        }
    };
    
    socket.onmessage = async (event) => {
        console.log("📨 Received:", event.data);
        
        try {
            const data = JSON.parse(event.data);
            if (data.clientId && data.clientId === clientId) {
                return;
            }

            if (data.type === 'TOTAL_DATA_RESPONSE') {
                totalDataTransferredBytes = (data.totalKB || 0) * 1024; // Convert back to bytes for consistency
                updateTotalDataTransferredUI();
                logSocket(`📊 Total data from DB: ${formatKilobytes(totalDataTransferredBytes)}`);
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
                logSocket(`📨 Received FETCH_REQUEST from ${data.requesterClientId || data.clientId}: ${data.request?.url}`);
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
                if (Array.isArray(data.items) && data.items.length > 0) {
                    data.items.forEach((item) => applyQueueAdd(item, 'remote'));
                    logSocket(`✅ Received ${data.items.length} queued item(s) from remote flush`);
                } else {
                    applyQueueFlush('remote');
                }
                return;
            }

            if (data.type === 'SYNC_RESPONSE') {
                const items = Array.isArray(data.items) ? data.items : [];
                logSocket(`✅ SYNC_RESPONSE received ${items.length} recovered item(s)`);
                items.forEach((item, index) => {
                    const payload = item.payload || {};
                    if (payload.type === 'queue:add' && payload.item) {
                        applyQueueAdd(payload.item, 'sync');
                    } else if (payload.type === 'FETCH_REQUEST' && deviceRole === 'provider') {
                        logSocket(`🔄 Recovered FETCH_REQUEST: ${payload.request?.url}`);
                        handleProviderFetchRequest(payload).catch((err) => {
                            console.error('Provider recovered fetch failed:', err);
                        });
                    } else {
                        logSocket(`🔄 Synced item ${index + 1}: ${JSON.stringify(payload).slice(0, 120)}`);
                    }
                });
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
        scheduleReconnect(url);
    };
}

function scheduleReconnect(url) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logSocket(`❌ Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Offline mode active.`);
        reconnectInProgress = false;
        return;
    }

    if (reconnectInProgress) {
        return;
    }

    reconnectInProgress = true;
    reconnectAttempts++;
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    logSocket(`⏳ Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }
    
    reconnectTimeout = setTimeout(() => {
        reconnectInProgress = false;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            logSocket(`🔄 Attempting to reconnect...`);
            connectToSocket(url);
        }
    }, delay);
}

function tryAutoReconnect() {
    if (!navigator.onLine) {
        return;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        return;
    }

    if (!lastSocketUrl) {
        logSocket('⚠️ No socket URL available for reconnect. Please connect manually.');
        return;
    }

    logSocket('🔄 Auto-reconnect triggered by network restore.');
    connectToSocket(lastSocketUrl);
}

function disconnectSocket() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    
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

// 10. Offline queue status
function updateOfflineQueueStatus() {
    const offlineQueue = getOfflineQueue();
    const statusElement = document.getElementById('offlineQueueStatus');
    if (statusElement) {
        if (offlineQueue.length === 0) {
            statusElement.textContent = '📦 Offline queue: 0 items';
            statusElement.style.color = 'inherit';
        } else {
            statusElement.textContent = `📦 Offline queue: ${offlineQueue.length} items`;
            statusElement.style.color = '#ff6b6b';
        }
    }
}

// 11. Utility function
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}


