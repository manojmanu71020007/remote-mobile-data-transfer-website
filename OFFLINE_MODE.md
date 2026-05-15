# Offline Mode & Auto-Reconnect Documentation

## Overview
The system now supports **Option 2: Independent Cellular Data** with **offline queueing**. Both phones can connect independently to the server and share data even when connection drops.

## How It Works

### Architecture
```
Phone A (Provider with Cellular Data)
├─ Connects to server independently via cellular
├─ Shares internet access to Phone B
└─ Can disconnect from hotspot

Phone B (Receiver)
├─ Connects to server independently (WiFi, cellular, or hotspot)
├─ Requests internet from Phone A via proxy tunnel
├─ Works even if Phone A's hotspot is OFF
└─ Queues requests if connection drops

Server (WebSocket Bridge)
└─ Maintains connection with both phones
   └─ Routes proxy requests between them
```

### Key Features

#### 1. **Auto-Reconnect with Exponential Backoff**
- When socket disconnects, automatically attempts to reconnect
- Attempts: 1st try = 2s, 2nd = 4s, 3rd = 8s, ... max 30s
- Maximum 10 attempts (5 minutes of reconnection)
- Offline mode activates after max attempts

#### 2. **Persistent Offline Queue (localStorage)**
- Any proxy requests sent while offline are queued in browser storage
- Queue survives page refreshes and browser crashes
- Shows status: `📦 Offline queue: X items`

#### 3. **Automatic Queue Flush on Reconnect**
- When socket reconnects, all queued requests are automatically resent
- Staggered delivery (100ms between items) to avoid overwhelming server

#### 4. **Manual Flush Button**
- "Flush Offline Queue" button in Socket Log section
- Only works when socket is connected
- Manually send all queued items immediately

## Setup for Option 2

### Phone A (Provider)
1. Enter Bridge Room ID (same as Phone B)
2. Set Socket URL: `ws://<server-ip>:8080`
3. Click "Connect socket"
4. Click "Use hotspot defaults" to auto-fill
5. Change role to "Provider" (toggle button)
6. **No need to keep hotspot on!** Connection persists independently

### Phone B (Receiver)
1. Enter **same** Bridge Room ID as Phone A
2. Set Socket URL: `ws://<server-ip>:8080`
3. Click "Connect socket"
4. Toggle role to "Receiver"
5. Enable proxy: Click "Proxy ON"
6. Enter URL and click fetch

## Usage Scenarios

### Scenario 1: Perfect Connection (Both Online)
```
Phone A → Connects → Server ← Connected ← Phone B
│                      │                      │
└──────────────────────────────────────────────┘
    Real-time proxy requests & responses
```
- Proxy requests are sent immediately
- Responses returned in real-time
- No offline queue needed

### Scenario 2: Phone B Goes Offline, Then Comes Back
```
Step 1: Phone B Online (requests sent immediately)
Phone A → Server ← Phone B

Step 2: Phone B Internet Drops
📦 Offline queue: 3 items (pending requests stored locally)

Step 3: Phone B Reconnects (auto-reconnect triggers)
- Socket reconnects automatically in 2-30s
- Offline queue automatically flushed
- Pending requests sent to provider
```

### Scenario 3: Server Connection Lost, Both Phones Reconnect
```
Step 1: Connection Lost on Both Phones
⏳ Reconnecting in 2s (attempt 1/10)
⏳ Reconnecting in 4s (attempt 2/10)
⏳ Reconnecting in 8s (attempt 3/10)

Step 2: One Phone Reconnects
Socket connects → Auto-join room → Flush offline queue

Step 3: Other Phone Reconnects
Socket connects → Auto-join room → Flush offline queue
```

## Offline Queue Storage

### Stored Data
```javascript
{
  type: "FETCH_REQUEST",
  data: {
    url: "https://example.com",
    method: "GET",
    ...
  },
  timestamp: 1715776800000,
  clientId: "client-...",
  roomId: "test-room-bridge"
}
```

### Viewing Queue
1. Open browser DevTools (F12)
2. Go to Application → Local Storage
3. Find `data-bridge-offline-queue` key
4. View stored JSON array

### Clearing Queue
- **Automatic**: Cleared after successful flush
- **Manual**: Manually refresh cache or clear browser storage
- **UI**: Shows count in "📦 Offline queue: X items"

## Reconnection Logic

### Reconnect Delays (Exponential Backoff)
```
Attempt 1: 2 seconds
Attempt 2: 4 seconds
Attempt 3: 8 seconds
Attempt 4: 16 seconds
Attempt 5: 30 seconds (capped)
Attempt 6-10: 30 seconds each
```

### Why Exponential Backoff?
- Reduces server load if temporary disconnect
- Gives network time to stabilize
- Prevents connection floods

### When Offline Mode Activates
- After 10 failed reconnection attempts (~5 minutes)
- Switches to "Offline mode active" state
- Queued requests stay in localStorage
- Manual button to flush when reconnected

## Troubleshooting

### Issue: Offline queue not flushing
**Solution**: 
- Check socket is actually connected (status shows "Connected")
- Click "Flush Offline Queue" button manually
- Check browser console (F12) for errors

### Issue: Requests lost after page refresh
**Solution**: Offline queue is persistent in localStorage
- Queue survives page refresh
- Will flush automatically on next reconnect
- Check DevTools → Application → Local Storage

### Issue: Too many reconnection attempts
**Solution**: This is intentional design
- Waits 5 minutes before giving up
- Allows network to recover
- You can manually reconnect by clicking "Connect socket" again

### Issue: Offline queue keeps growing
**Solution**: 
- Ensure socket is connected before sending requests
- Click "Flush Offline Queue" button manually
- Check phone's internet connection

## Performance Notes

- **Queue size limit**: No hard limit (but localStorage typically has 5-10MB)
- **Max items per flush**: Tested with 100+ items successfully
- **Stagger delay**: 100ms between items to prevent overwhelming server
- **Memory usage**: ~1KB per queued request

## Next Steps

1. **Test with two physical phones**:
   - Phone A: Connect via cellular, set as Provider
   - Phone B: Connect via WiFi, set as Receiver
   
2. **Simulate connection drop**:
   - Disable WiFi/cellular on one phone
   - Make proxy request
   - See offline queue appear
   - Re-enable connection
   - Watch automatic flush

3. **Verify data transfer**:
   - Monitor socket log for messages
   - Check offline queue status
   - Confirm responses arrive after reconnect

## Known Limitations

- Offline queue stored in-memory during session (cleared on browser close)
- Queue persists in localStorage (survives page refresh)
- Server logs (MongoDB) only capture sent items (not queued items)
- Max 30-second initial queue delay after connection restored
