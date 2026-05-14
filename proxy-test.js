let socket = null;
let clientId = null;
let bridgeRoomId = '';
let proxyEnabled = false;
const FALLBACK_SOCKET_URL = 'ws://10.98.169.218:8080';
const ROOM_STORAGE_KEY = 'data-bridge-proxy-room-id';
const PROXY_STORAGE_KEY = 'data-bridge-proxy-enabled';

function createClientId() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getElement(id) {
  return document.getElementById(id);
}

function log(message) {
  const logArea = getElement('requestLog');
  if (!logArea) return;
  const timestamp = new Date().toLocaleTimeString();
  logArea.value += `[${timestamp}] ${message}\n`;
  logArea.scrollTop = logArea.scrollHeight;
}

function setStatus(id, text) {
  const element = getElement(id);
  if (element) {
    element.textContent = text;
  }
}

function loadStoredValue(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

function storeValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // ignore storage failures
  }
}

function headersToObject(headers) {
  const result = {};
  if (!headers) return result;
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToText(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

async function postToServiceWorker(message) {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(message);
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  registration.active?.postMessage(message);
}

function updateProxyUi() {
  setStatus('proxyStatus', proxyEnabled ? 'Proxy: on' : 'Proxy: off');
  getElement('proxyToggleBtn').textContent = proxyEnabled ? 'Proxy ON' : 'Proxy OFF';
}

function updateBridgeUi(text) {
  setStatus('bridgeStatus', text);
  setStatus('bridgeHint', bridgeRoomId ? `Room: ${bridgeRoomId}` : 'Connect first, then enable proxy.');
}

function sendSocketEvent(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type,
    clientId,
    roomId: bridgeRoomId,
    timestamp: new Date().toISOString(),
    ...payload,
  }));
}

function sendRole() {
  sendSocketEvent('bridge:role', { role: 'receiver' });
}

function connectSocket() {
  const url = getElement('socketUrlInput').value.trim() || FALLBACK_SOCKET_URL;
  const roomId = getElement('bridgeKeyInput').value.trim();

  if (!roomId) {
    updateBridgeUi('Bridge: missing key');
    log('❌ Enter a room ID first');
    return;
  }

  bridgeRoomId = roomId;
  storeValue(ROOM_STORAGE_KEY, roomId);
  updateBridgeUi('Bridge: connecting');
  log(`Connecting to ${url} as receiver in room ${roomId}...`);

  socket = new WebSocket(url);
  socket.onopen = () => {
    updateBridgeUi('Bridge: connected');
    log('✅ Connected');
    sendSocketEvent('bridge:join', { roomId: bridgeRoomId });
    sendRole();
    if (proxyEnabled) {
      postToServiceWorker({ type: 'PROXY_STATE', enabled: true, clientId });
    }
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'bridge:joined') {
        log(`✅ Joined room ${data.roomId}`);
        return;
      }

      if (data.type === 'bridge:role-ack') {
        log(`✅ Role acknowledged: ${data.role}`);
        return;
      }

      if (data.type === 'FETCH_REQUEST') {
        log(`📥 FETCH_REQUEST for ${data.request?.url || 'unknown URL'}`);
        return;
      }

      if (data.type === 'FETCH_RESPONSE') {
        await postToServiceWorker({
          type: 'BRIDGE_PROXY_RESPONSE',
          requestId: data.requestId,
          response: data.response,
        });
        log(`📤 FETCH_RESPONSE delivered (${data.response?.status || 'n/a'})`);
        return;
      }

      log(`📨 ${event.data.substring(0, 120)}`);
    } catch (error) {
      log(`📨 ${event.data.substring(0, 120)}`);
    }
  };

  socket.onerror = (error) => {
    updateBridgeUi('Bridge: error');
    log(`❌ Socket error: ${error.message || error}`);
  };

  socket.onclose = () => {
    updateBridgeUi('Bridge: disconnected');
    log('🔌 Socket closed');
  };
}

function disconnectSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
  updateBridgeUi('Bridge: disconnected');
  log('Disconnected');
}

function toggleProxy() {
  proxyEnabled = !proxyEnabled;
  storeValue(PROXY_STORAGE_KEY, String(proxyEnabled));
  updateProxyUi();
  postToServiceWorker({ type: 'PROXY_STATE', enabled: proxyEnabled, clientId });
  log(proxyEnabled ? 'Proxy enabled' : 'Proxy disabled');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setStatus('swStatus', 'Service worker: unsupported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    setStatus('swStatus', 'Service worker: active');
    navigator.serviceWorker.addEventListener('message', async (event) => {
      const data = event.data || {};
      if (data.type === 'BRIDGE_PROXY_REQUEST') {
        await handleBridgeProxyRequest(data);
      }
    });
    if (registration) {
      // keep registration alive for updates
    }
  } catch (error) {
    console.error(error);
    setStatus('swStatus', 'Service worker: error');
  }
}

async function handleBridgeProxyRequest(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await postToServiceWorker({
      type: 'BRIDGE_PROXY_RESPONSE',
      requestId: payload.requestId,
      response: {
        ok: false,
        status: 503,
        statusText: 'Bridge offline',
        headers: { 'content-type': 'text/plain' },
        bodyText: 'Bridge socket is not connected.'
      }
    });
    return;
  }

  sendSocketEvent('FETCH_REQUEST', {
    requestId: payload.requestId,
    requesterClientId: clientId,
    request: payload.request,
    sender: 'receiver',
    targetRole: 'provider'
  });
}

async function sendProxyRequest() {
  const requestUrl = getElement('requestUrlInput').value.trim();
  const method = getElement('requestMethodInput').value;
  const rawBody = getElement('requestBodyInput').value.trim();

  if (!requestUrl) {
    log('❌ Enter a request URL');
    return;
  }

  try {
    const options = { method };
    if (rawBody && method !== 'GET' && method !== 'HEAD') {
      options.headers = { 'content-type': 'application/json' };
      options.body = rawBody;
    }

    log(`➡️ Fetching ${requestUrl} via bridge proxy...`);
    const response = await fetch(requestUrl, options);
    const text = await response.text();
    getElement('responseOutput').value = `Status: ${response.status} ${response.statusText}\n\n${text}`;
    log(`✅ Request complete (${response.status})`);
  } catch (error) {
    getElement('responseOutput').value = `Error: ${error.message}`;
    log(`❌ Fetch failed: ${error.message}`);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  clientId = createClientId();
  getElement('bridgeKeyInput').value = loadStoredValue(ROOM_STORAGE_KEY);
  proxyEnabled = loadStoredValue(PROXY_STORAGE_KEY) === 'true';
  updateProxyUi();
  updateBridgeUi('Bridge: idle');
  setStatus('netStatus', navigator.onLine ? 'Network: online' : 'Network: offline');

  getElement('connectBtn').onclick = connectSocket;
  getElement('disconnectBtn').onclick = disconnectSocket;
  getElement('proxyToggleBtn').onclick = toggleProxy;
  getElement('sendRequestBtn').onclick = sendProxyRequest;
  getElement('clearBtn').onclick = () => {
    getElement('requestLog').value = '';
    getElement('responseOutput').value = '';
  };

  getElement('bridgeKeyInput').addEventListener('input', () => {
    bridgeRoomId = getElement('bridgeKeyInput').value.trim();
    storeValue(ROOM_STORAGE_KEY, bridgeRoomId);
  });

  await registerServiceWorker();
  await postToServiceWorker({ type: 'PROXY_STATE', enabled: proxyEnabled, clientId });
  log('Proxy test page ready');
});
