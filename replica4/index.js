const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const REPLICA_ID = process.env.REPLICA_ID || "1";
const PEERS = process.env.PEERS ? process.env.PEERS.split(',') : [];
const GATEWAY_URL = 'http://gateway:8080';

const TOTAL_NODES = PEERS.length + 1;
const QUORUM = Math.floor(TOTAL_NODES / 2) + 1;
console.log(`[NODE ${REPLICA_ID}] Total Nodes: ${TOTAL_NODES} | Required Quorum: ${QUORUM}`);

let state = 'Follower';
let currentTerm = 0;
let votedFor = null;
let log = [];
let commitIndex = -1;

// --- NETWORK PARTITION STATE ---
let partitionedPeers = new Set();

let electionTimer = null;
let heartbeatTimer = null;

const getRandomElectionTimeout = () => Math.floor(Math.random() * (800 - 500 + 1)) + 500;

// ---------------------------------------------------------
// PARTITION-AWARE HTTP HELPER
// ---------------------------------------------------------
async function peerPost(peer, path, body, options = {}) {
    if (partitionedPeers.has(peer)) {
        throw new Error(`[PARTITION] Node ${REPLICA_ID} is partitioned from ${peer}. Dropping ${path}`);
    }
    return axios.post(`http://${peer}${path}`, body, options);
}

// ---------------------------------------------------------
// RAFT LOGIC: TIMERS & ELECTIONS
// ---------------------------------------------------------
function resetElectionTimer() {
    if (electionTimer) clearTimeout(electionTimer);
    electionTimer = setTimeout(() => {
        startElection();
    }, getRandomElectionTimeout());
}

async function startElection() {
    state = 'Candidate';
    currentTerm++;
    const electionTerm = currentTerm;
    votedFor = REPLICA_ID;
    let votesReceived = 1;

    console.log(`[NODE ${REPLICA_ID}] Term ${electionTerm}: Timeout reached! Starting election...`);

    const votePromises = PEERS.map(async (peer) => {
        try {
            const response = await peerPost(peer, '/request-vote', {
                term: electionTerm,
                candidateId: REPLICA_ID
            }, { timeout: 300 });

            if (response.data.voteGranted) {
                votesReceived++;
            } else if (response.data.term > currentTerm) {
                currentTerm = response.data.term;
                state = 'Follower';
                votedFor = null;
            }
        } catch (error) { /* Dead or partitioned peer — ignore */ }
    });

    await Promise.all(votePromises);

    if (currentTerm !== electionTerm || state !== 'Candidate') return;

    if (votesReceived >= QUORUM) {
        becomeLeader();
    } else {
        console.log(`[NODE ${REPLICA_ID}] Term ${electionTerm}: Lost election (Split vote/No quorum). Back to Follower.`);
        state = 'Follower';
        resetElectionTimer();
    }
}

// REPLACE this function in all 4 replica index.js files

function becomeLeader() {
    state = 'Leader';
    console.log(`\n👑 [NODE ${REPLICA_ID}] is now the LEADER for Term ${currentTerm}! 👑\n`);
    if (electionTimer) clearTimeout(electionTimer);

    // Retry /set-leader up to 5 times with 500ms delay
    // Handles the race condition where gateway isn't ready yet on startup
    const registerWithGateway = (retriesLeft) => {
        axios.post(`${GATEWAY_URL}/set-leader`, {
            leaderId: REPLICA_ID,
            leaderUrl: `http://replica${REPLICA_ID}:${PORT}`
        }).catch(() => {
            if (retriesLeft > 0) {
                setTimeout(() => registerWithGateway(retriesLeft - 1), 500);
            }
        });
    };
    registerWithGateway(5);

    sendHeartbeats();
    heartbeatTimer = setInterval(sendHeartbeats, 150);
}

function sendHeartbeats() {
    PEERS.forEach(peer => {
        peerPost(peer, '/heartbeat', {
            term: currentTerm,
            leaderId: REPLICA_ID
        }, { timeout: 100 }).catch((e) => {
            if (e.message.includes('[PARTITION]')) console.log(e.message);
        });
    });
}

// ---------------------------------------------------------
// RPC ENDPOINTS
// ---------------------------------------------------------
app.post('/heartbeat', (req, res) => {
    const { term, leaderId } = req.body;
    if (term >= currentTerm) {
        currentTerm = term;
        state = 'Follower';
        votedFor = null;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        resetElectionTimer();
    }
    res.json({ success: true, term: currentTerm });
});

app.post('/request-vote', (req, res) => {
    const { term, candidateId } = req.body;
    let voteGranted = false;
    if (term > currentTerm) {
        currentTerm = term;
        state = 'Follower';
        votedFor = null;
    }
    if (term === currentTerm && (votedFor === null || votedFor === candidateId)) {
        voteGranted = true;
        votedFor = candidateId;
        resetElectionTimer();
    }
    res.json({ term: currentTerm, voteGranted });
});

// ---------------------------------------------------------
// STROKE REPLICATION & CONSENSUS
// ---------------------------------------------------------
app.post('/process-stroke', async (req, res) => {
    if (state !== 'Leader') {
        return res.status(400).json({ error: "I am not the leader!" });
    }
    const { stroke } = req.body;
    const entry = { term: currentTerm, stroke: stroke };
    log.push(entry);
    const entryIndex = log.length - 1;
    let acks = 1;

    const replicationPromises = PEERS.map(async (peer) => {
        try {
            const response = await peerPost(peer, '/append-entries', {
                term: currentTerm,
                leaderId: REPLICA_ID,
                prevLogIndex: entryIndex - 1,
                prevLogTerm: entryIndex - 1 >= 0 ? log[entryIndex - 1].term : null,
                entries: [entry],
                leaderCommit: commitIndex
            }, { timeout: 500 });

            if (response.data.success) {
                acks++;
            } else if (response.data.logLength !== undefined && response.data.logLength < log.length) {
                console.log(`[NODE ${REPLICA_ID}] Follower ${peer} is behind. Initiating /sync-log...`);
                const missingEntries = log.slice(response.data.logLength);
                await peerPost(peer, '/sync-log', {
                    missingEntries: missingEntries,
                    leaderCommit: commitIndex
                });
                acks++;
            }
        } catch (error) { /* Dead or partitioned peer */ }
    });

    await Promise.all(replicationPromises);

    if (acks >= QUORUM && state === 'Leader') {
        commitIndex = entryIndex;
        axios.post(`${GATEWAY_URL}/broadcast`, { stroke }).catch(() => {});
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "Quorum not reached" });
    }
});

app.post('/append-entries', (req, res) => {
    const { term, leaderId, prevLogIndex, prevLogTerm, entries, leaderCommit } = req.body;
    if (term < currentTerm) {
        return res.json({ term: currentTerm, success: false, logLength: log.length });
    }
    if (term >= currentTerm) {
        currentTerm = term;
        state = 'Follower';
        votedFor = null;
        resetElectionTimer();
    }
    if (log.length <= prevLogIndex && prevLogIndex !== -1) {
        return res.json({ term: currentTerm, success: false, logLength: log.length });
    }
    if (entries && entries.length > 0) {
        const expectedNextIndex = prevLogIndex + 1;
        if (log.length <= expectedNextIndex) {
            log.push(...entries);
        }
    }
    if (leaderCommit > commitIndex) {
        commitIndex = Math.min(leaderCommit, log.length - 1);
    }
    res.json({ term: currentTerm, success: true, logLength: log.length });
});

app.post('/sync-log', (req, res) => {
    const { missingEntries, leaderCommit } = req.body;
    log.push(...missingEntries);
    commitIndex = leaderCommit;
    missingEntries.forEach(entry => {
        axios.post(`${GATEWAY_URL}/broadcast`, { stroke: entry.stroke }).catch(() => {});
    });
    console.log(`[NODE ${REPLICA_ID}] Catch-up complete! Log size is now ${log.length}.`);
    res.json({ success: true });
});

// ---------------------------------------------------------
// STATUS ENDPOINT
// ---------------------------------------------------------
app.get('/status', (req, res) => {
    res.json({
        id: REPLICA_ID,
        state: state,
        term: currentTerm,
        logSize: log.length,
        commitIndex: commitIndex,
        partitionedFrom: [...partitionedPeers]
    });
});

// ---------------------------------------------------------
// NETWORK PARTITION SIMULATION ENDPOINTS
// ---------------------------------------------------------
app.post('/partition', (req, res) => {
    const { peers } = req.body;
    if (!Array.isArray(peers)) {
        return res.status(400).json({ error: 'Body must be { peers: ["replica2:3002", ...] }' });
    }
    peers.forEach(p => partitionedPeers.add(p));
    console.log(`\n🔥 [NODE ${REPLICA_ID}] PARTITION ACTIVATED. Blocked peers: [${[...partitionedPeers]}]\n`);
    res.json({ success: true, node: REPLICA_ID, partitionedFrom: [...partitionedPeers] });
});

app.post('/heal', (req, res) => {
    const { peers } = req.body;
    if (!peers || peers.length === 0) {
        const healed = [...partitionedPeers];
        partitionedPeers.clear();
        console.log(`\n✅ [NODE ${REPLICA_ID}] ALL PARTITIONS HEALED. Back online.\n`);
        return res.json({ success: true, node: REPLICA_ID, healed });
    }
    peers.forEach(p => partitionedPeers.delete(p));
    console.log(`\n✅ [NODE ${REPLICA_ID}] Partition healed with: [${peers}]\n`);
    res.json({ success: true, node: REPLICA_ID, partitionedFrom: [...partitionedPeers] });
});

// ---------------------------------------------------------
// BOOT
// ---------------------------------------------------------
app.listen(PORT, () => {
    console.log(`[NODE ${REPLICA_ID}] Booted on port ${PORT}. Status: ${state}`);
    resetElectionTimer();
});