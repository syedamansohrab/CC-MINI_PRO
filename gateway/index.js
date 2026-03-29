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
    cors: { origin: "*" } // Allow the frontend to connect from any port
});

// The gateway doesn't decide the state; it just needs to know who the boss is!
let currentLeader = null;

// ---------------------------------------------------------
// REST ENDPOINTS (For internal communication with Replicas)
// ---------------------------------------------------------

// 1. Replicas will call this endpoint when they win an election
app.post('/set-leader', (req, res) => {
    const { leaderId, leaderUrl } = req.body;
    currentLeader = leaderUrl;
    console.log(`[GATEWAY] Traffic re-routed. New Leader is Replica ${leaderId} at ${leaderUrl}`);
    res.sendStatus(200);
});

// 2. The Leader calls this when a stroke is safely committed to the log
app.post('/broadcast', (req, res) => {
    const { stroke } = req.body;
    io.emit('draw-stroke', stroke); // Broadcast to all connected browser clients
    res.sendStatus(200);
});

// ---------------------------------------------------------
// WEBSOCKET LOGIC (For communication with the Browser)
// ---------------------------------------------------------

io.on('connection', (socket) => {
    console.log(`[GATEWAY] New browser client connected: ${socket.id}`);

    // When a user draws on the canvas, they send a stroke here
    socket.on('send-stroke', async (stroke) => {
        if (!currentLeader) {
            console.log('[GATEWAY] No leader elected yet. Dropping stroke.');
            return;
        }

        try {
            // Forward the stroke to the current active leader replica
            await axios.post(`${currentLeader}/process-stroke`, { stroke });
        } catch (error) {
            console.log('[GATEWAY] Failed to send stroke. The Leader might have crashed!');
            // In the RAFT protocol, if this fails, the replicas will soon notice
            // the leader is dead and elect a new one. The gateway will wait for the update.
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