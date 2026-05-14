const CACHE_NAME = "data-bridge-cache-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
];

const proxyEnabledClients = new Set();
const pendingProxyRequests = new Map();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
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
  headers.forEach((value, key) => {
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

async function serializeRequest(request) {
  const bodyBase64 = request.method === "GET" || request.method === "HEAD"
    ? null
    : arrayBufferToBase64(await request.clone().arrayBuffer());

  return {
    url: request.url,
    method: request.method,
    headers: headersToObject(request.headers),
    bodyBase64,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
  };
}

function responseFromPayload(payload) {
  if (!payload) {
    return new Response("Proxy response missing", { status: 502 });
  }

  if (payload.bodyText !== undefined && payload.bodyText !== null) {
    return new Response(payload.bodyText, {
      status: payload.status || 200,
      statusText: payload.statusText || "OK",
      headers: objectToHeaders(payload.headers),
    });
  }

  const body = payload.bodyBase64 ? base64ToArrayBuffer(payload.bodyBase64) : null;
  return new Response(body, {
    status: payload.status || 200,
    statusText: payload.statusText || "OK",
    headers: objectToHeaders(payload.headers),
  });
}

async function proxyFetchThroughBridge(event) {
  const clientId = event.clientId;
  if (!clientId || !proxyEnabledClients.has(clientId)) {
    return fetch(event.request);
  }

  const controlledClient = await self.clients.get(clientId);
  if (!controlledClient) {
    return new Response("Bridge proxy client unavailable", { status: 503 });
  }

  const requestId = `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestPayload = await serializeRequest(event.request);

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingProxyRequests.delete(requestId);
      resolve(new Response("Bridge proxy timed out", { status: 504 }));
    }, 30000);

    pendingProxyRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timeoutId);
        resolve(responseFromPayload(payload));
      }
    });

    controlledClient.postMessage({
      type: "BRIDGE_PROXY_REQUEST",
      requestId,
      request: requestPayload,
    });
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === "PROXY_STATE") {
    if (event.source?.id) {
      if (event.data.enabled) {
        proxyEnabledClients.add(event.source.id);
      } else {
        proxyEnabledClients.delete(event.source.id);
      }
    }
    return;
  }

  if (event.data?.type === "BRIDGE_PROXY_RESPONSE" && event.data.requestId) {
    const pending = pendingProxyRequests.get(event.data.requestId);
    if (pending) {
      pendingProxyRequests.delete(event.data.requestId);
      pending.resolve(event.data.response);
    }
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    if (proxyEnabledClients.has(event.clientId)) {
      event.respondWith(proxyFetchThroughBridge(event));
      return;
    }
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (proxyEnabledClients.has(event.clientId) && requestUrl.origin !== self.location.origin) {
    event.respondWith(proxyFetchThroughBridge(event));
    return;
  }

  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Always fetch JS and HTML files from network (no cache)
  if (requestUrl.pathname.endsWith('.js') || requestUrl.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        // Fallback to cache if offline
        return (await caches.match(event.request)) || (await caches.match("./index.html"));
      })
    );
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(async () => (await caches.match("./index.html")) || (await caches.match("./"))),
    );
    return;
  }

  if (APP_SHELL.includes(requestUrl.pathname) || APP_SHELL.includes(`.${requestUrl.pathname}`)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        });
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    }),
  );
});
