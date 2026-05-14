# Remote Mobile Data Transfer Website (Data Bridge)

A small PWA that syncs a simple queue across devices using a WebSocket broadcaster.

## Quick start

- Install dependencies (optional):

```powershell
npm install
```

- Start the server:

```powershell
node server.js
```

- Open the app in a browser:

- `http://localhost:8080` on the same machine, or
- `http://<LAN_IP>:8080` from another device on the same network (phone).

## How syncing works

- Clients connect to the WebSocket server in `server.js` and broadcast JSON events.
- Supported event types used by the UI:
  - `queue:add` — payload includes `item`, `clientId`, `timestamp`.
  - `queue:flush` — payload includes `clientId`, `timestamp`.
- Each client generates a `clientId` and ignores incoming events with the same `clientId` to avoid echoing its own actions.

## Testing

1. Open the app on two devices (desktop + phone) pointing to the server URL.
2. Add an item to the queue on one device — it should appear on the other device and be logged in the socket log.
3. Use the "Flush queue" action on one device — both clients should clear their queues and record the `queue:flush` event.

## Notes

- The server broadcasts all received messages to every connected client. Keep clients updated to the latest `app.js` to avoid legacy parsing issues.
- Repo: https://github.com/manojmanu71020007/remote-mobile-data-transfer-website
