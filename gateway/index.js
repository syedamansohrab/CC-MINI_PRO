// gateway/index.js
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

async function fetchLeaderBoardState() {
    if (!currentLeader) {
        return {
            visibleStrokes: [],
            canUndo: false,
            canRedo: false,
            totalOperations: 0
        };
    }

    try {
        const response = await axios.get(`${currentLeader}/board-state`, { timeout: 500 });
        return response.data;
    } catch (error) {
        return {
            visibleStrokes: [],
            canUndo: false,
            canRedo: false,
            totalOperations: 0
        };
    }
}

// ---------------------------------------------------------
// REST ENDPOINTS (For internal communication with Replicas)
// ---------------------------------------------------------

app.post('/set-leader', (req, res) => {
    const { leaderId, leaderUrl } = req.body;
    currentLeader = leaderUrl;
    console.log(`[GATEWAY] Traffic re-routed. New Leader is Replica ${leaderId} at ${leaderUrl}`);
    res.sendStatus(200);
});

app.post('/broadcast-state', (req, res) => {
    io.emit('board-state', req.body);
    res.sendStatus(200);
});

// ---------------------------------------------------------
// DASHBOARD AGGREGATOR ENDPOINT (NEW)
// ---------------------------------------------------------
app.get('/cluster-status', async (req, res) => {
    // We now have 4 replicas to check
    const replicas = ['replica1:3001', 'replica2:3002', 'replica3:3003', 'replica4:3004'];
    
    const statuses = await Promise.all(replicas.map(async (url) => {
        try {
            // Fast timeout so one dead node doesn't hang the dashboard
            const response = await axios.get(`http://${url}/status`, { timeout: 300 });
            return response.data;
        } catch (error) {
            // If the node is dead/restarting, return an offline state
            return { 
                id: url.split(':')[0].replace('replica', ''), 
                state: 'Offline ❌', 
                term: '-', 
                logSize: '-', 
                commitIndex: '-' 
            };
        }
    }));

    res.json(statuses);
});

// ---------------------------------------------------------
// WEBSOCKET LOGIC (For communication with the Browser)
// ---------------------------------------------------------

io.on('connection', (socket) => {
    console.log(`[GATEWAY] New browser client connected: ${socket.id}`);

    fetchLeaderBoardState().then((boardState) => {
        socket.emit('board-state', boardState);
    });

    socket.on('send-stroke', async (stroke) => {
        if (!currentLeader) {
            console.log('[GATEWAY] No leader elected yet. Dropping stroke.');
            return;
        }

        try {
            await axios.post(`${currentLeader}/process-stroke`, { stroke });
        } catch (error) {
            console.log('[GATEWAY] Failed to send stroke. The Leader might have crashed!');
        }
    });

    socket.on('undo', async () => {
        if (!currentLeader) {
            console.log('[GATEWAY] No leader elected yet. Cannot process undo.');
            return;
        }

        try {
            await axios.post(`${currentLeader}/process-undo`);
        } catch (error) {
            console.log('[GATEWAY] Failed to process undo request.');
        }
    });

    socket.on('redo', async () => {
        if (!currentLeader) {
            console.log('[GATEWAY] No leader elected yet. Cannot process redo.');
            return;
        }

        try {
            await axios.post(`${currentLeader}/process-redo`);
        } catch (error) {
            console.log('[GATEWAY] Failed to process redo request.');
        }
    });

    socket.on('disconnect', () => {
        console.log(`[GATEWAY] Client disconnected: ${socket.id}`);
    });
});

// Start the Gateway server
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`[GATEWAY] WebSocket Server running on port ${PORT}`);
});
