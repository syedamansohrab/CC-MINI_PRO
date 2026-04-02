const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

let currentLeader = null;

const REPLICAS = [
    { id: '1', url: 'http://replica1:3001' },
    { id: '2', url: 'http://replica2:3002' },
    { id: '3', url: 'http://replica3:3003' },
    { id: '4', url: 'http://replica4:3004' },
];

// ---------------------------------------------------------
// LEADER DISCOVERY — polls replicas to find the current leader
// Called on startup and whenever a stroke fails
// ---------------------------------------------------------
async function discoverLeader() {
    for (const replica of REPLICAS) {
        try {
            const response = await axios.get(`${replica.url}/status`, { timeout: 300 });
            if (response.data.state === 'Leader') {
                currentLeader = replica.url;
                console.log(`[GATEWAY] Leader discovered: Replica ${replica.id} at ${replica.url}`);
                return;
            }
        } catch (error) { /* replica offline, try next */ }
    }
    console.log('[GATEWAY] No leader found yet. Will retry on next stroke.');
    currentLeader = null;
}

// Poll for a leader every 2 seconds until one is found
const leaderPollInterval = setInterval(async () => {
    if (!currentLeader) {
        await discoverLeader();
    } else {
        clearInterval(leaderPollInterval);
    }
}, 2000);

// ---------------------------------------------------------
// REST ENDPOINTS
// ---------------------------------------------------------

app.post('/set-leader', (req, res) => {
    const { leaderId, leaderUrl } = req.body;
    currentLeader = leaderUrl;
    console.log(`[GATEWAY] Traffic re-routed. New Leader is Replica ${leaderId} at ${leaderUrl}`);
    res.sendStatus(200);
});

app.post('/broadcast', (req, res) => {
    const { stroke } = req.body;
    io.emit('draw-stroke', stroke);
    res.sendStatus(200);
});

app.get('/cluster-status', async (req, res) => {
    const statuses = await Promise.all(REPLICAS.map(async (replica) => {
        try {
            const response = await axios.get(`${replica.url}/status`, { timeout: 300 });
            return response.data;
        } catch (error) {
            return {
                id: replica.id,
                state: 'Offline ❌',
                term: '-',
                logSize: '-',
                commitIndex: '-',
                partitionedFrom: []
            };
        }
    }));
    res.json(statuses);
});

// ---------------------------------------------------------
// WEBSOCKET
// ---------------------------------------------------------

io.on('connection', (socket) => {
    console.log(`[GATEWAY] New browser client connected: ${socket.id}`);

    socket.on('send-stroke', async (stroke) => {
        // If we don't know the leader, try to find one right now
        if (!currentLeader) {
            await discoverLeader();
        }

        if (!currentLeader) {
            console.log('[GATEWAY] No leader elected yet. Dropping stroke.');
            return;
        }

        try {
            await axios.post(`${currentLeader}/process-stroke`, { stroke });
        } catch (error) {
            // Leader might have crashed — clear it and rediscover on next stroke
            console.log('[GATEWAY] Failed to reach leader. Triggering rediscovery...');
            currentLeader = null;
            await discoverLeader();
        }
    });

    socket.on('disconnect', () => {
        console.log(`[GATEWAY] Client disconnected: ${socket.id}`);
    });
});

const PORT = 8080;
server.listen(PORT, () => {
    console.log(`[GATEWAY] WebSocket Server running on port ${PORT}`);
    // Try to find the leader immediately on boot
    discoverLeader();
});