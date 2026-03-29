// replica1/index.js (Copy this to replica2 and replica3 as well)
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- ENVIRONMENT CONFIGURATION ---
const PORT = process.env.PORT || 3001;
const REPLICA_ID = process.env.REPLICA_ID || "1";
const PEERS = process.env.PEERS ? process.env.PEERS.split(',') : []; 
const GATEWAY_URL = 'http://gateway:8080';

// --- RAFT PERSISTENT STATE ---
let state = 'Follower'; // [cite: 60]
let currentTerm = 0;
let votedFor = null;
let log = []; // [cite: 38]
let commitIndex = -1; 

// --- TIMERS ---
let electionTimer = null;
let heartbeatTimer = null;

// [cite: 64] Random election timeout between 500-800ms
const getRandomElectionTimeout = () => Math.floor(Math.random() * (800 - 500 + 1)) + 500;

// ---------------------------------------------------------
// RAFT LOGIC: TIMERS & ELECTIONS
// ---------------------------------------------------------

function resetElectionTimer() {
    if (electionTimer) clearTimeout(electionTimer);
    
    // [cite: 65, 66] Missing heartbeat triggers Candidate state
    electionTimer = setTimeout(() => {
        startElection();
    }, getRandomElectionTimeout());
}

async function startElection() {
    state = 'Candidate';
    currentTerm++;
    const electionTerm = currentTerm; // EDGE CASE FIX: Lock term to prevent stale payloads
    votedFor = REPLICA_ID; // [cite: 67]
    let votesReceived = 1; 

    console.log(`[NODE ${REPLICA_ID}] Term ${electionTerm}: Timeout reached! Starting election...`);

    const votePromises = PEERS.map(async (peer) => {
        try {
            // EDGE CASE FIX: Added timeout so a dead node doesn't hang the election
            const response = await axios.post(`http://${peer}/request-vote`, {
                term: electionTerm,
                candidateId: REPLICA_ID
            }, { timeout: 300 });

            if (response.data.voteGranted) {
                votesReceived++;
            } else if (response.data.term > currentTerm) {
                // [cite: 81] Higher term always wins. Step down immediately.
                currentTerm = response.data.term;
                state = 'Follower';
                votedFor = null;
            }
        } catch (error) { /* Peer is dead, ignore */ }
    });

    await Promise.all(votePromises);

    // EDGE CASE FIX: If our term changed while we waited for network responses, abort!
    if (currentTerm !== electionTerm || state !== 'Candidate') {
        return; 
    }

    // [cite: 68] Majority quorum is >= 2 out of 3
    if (votesReceived >= 2) {
        becomeLeader();
    } else {
        //  Split votes must retry election
        console.log(`[NODE ${REPLICA_ID}] Term ${electionTerm}: Lost election (Split vote/No quorum). Back to Follower.`);
        state = 'Follower';
        resetElectionTimer();
    }
}

function becomeLeader() {
    state = 'Leader';
    console.log(`\n👑 [NODE ${REPLICA_ID}] is now the LEADER for Term ${currentTerm}! 👑\n`);
    
    if (electionTimer) clearTimeout(electionTimer);

    // Re-route Gateway traffic [cite: 31]
    axios.post(`${GATEWAY_URL}/set-leader`, { 
        leaderId: REPLICA_ID, 
        leaderUrl: `http://replica${REPLICA_ID}:${PORT}` 
    }).catch(() => {});

    // [cite: 69] 150ms Heartbeat Interval
    sendHeartbeats();
    heartbeatTimer = setInterval(sendHeartbeats, 150);
}

function sendHeartbeats() {
    PEERS.forEach(peer => {
        axios.post(`http://${peer}/heartbeat`, {
            term: currentTerm,
            leaderId: REPLICA_ID
        }, { timeout: 100 }).catch(() => {}); 
    });
}

// ---------------------------------------------------------
// RPC ENDPOINTS (Internal Cluster Communication)
// ---------------------------------------------------------

// 1. /heartbeat API [cite: 45]
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

// 2. /request-vote API [cite: 43]
app.post('/request-vote', (req, res) => {
    const { term, candidateId } = req.body;
    let voteGranted = false;

    // [cite: 81] Higher term wins
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
// STROKE REPLICATION & CONSENSUS LOGIC
// ---------------------------------------------------------

// 3. /process-stroke API [cite: 74]
app.post('/process-stroke', async (req, res) => {
    if (state !== 'Leader') {
        return res.status(400).json({ error: "I am not the leader!" });
    }

    const { stroke } = req.body;
    const entry = { term: currentTerm, stroke: stroke };
    log.push(entry);
    const entryIndex = log.length - 1;

    let acks = 1; // Leader counts as 1 vote

    // [cite: 75] Send AppendEntries
    const replicationPromises = PEERS.map(async (peer) => {
        try {
            const response = await axios.post(`http://${peer}/append-entries`, {
                term: currentTerm,
                leaderId: REPLICA_ID,
                prevLogIndex: entryIndex - 1,
                prevLogTerm: entryIndex - 1 >= 0 ? log[entryIndex - 1].term : null,
                entries: [entry],
                leaderCommit: commitIndex
            }, { timeout: 500 }); // Fast timeout for dead nodes

            if (response.data.success) {
                acks++;
            } else if (response.data.logLength !== undefined && response.data.logLength < log.length) {
                // [cite: 83, 84, 86, 88] Trigger Catch-Up Protocol
                console.log(`[NODE ${REPLICA_ID}] Follower ${peer} is behind. Initiating /sync-log...`);
                const missingEntries = log.slice(response.data.logLength);
                
                await axios.post(`http://${peer}/sync-log`, {
                    missingEntries: missingEntries,
                    leaderCommit: commitIndex
                });
                acks++; 
            }
        } catch (error) { /* Dead peer */ }
    });

    await Promise.all(replicationPromises);

    // [cite: 77] Majority acknowledges
    if (acks >= 2 && state === 'Leader') {
        commitIndex = entryIndex;
        // [cite: 78] Broadcast to Gateway
        axios.post(`${GATEWAY_URL}/broadcast`, { stroke }).catch(() => {});
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "Quorum not reached" });
    }
});

// 4. /append-entries API [cite: 44]
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

    // [cite: 86, 87] Catch-Up Logic Check
    if (log.length <= prevLogIndex && prevLogIndex !== -1) {
        return res.json({ term: currentTerm, success: false, logLength: log.length });
    }

    //  EDGE CASE FIX: Idempotency. Only push if we don't already have it.
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

// 5. /sync-log API [cite: 46]
app.post('/sync-log', (req, res) => {
    const { missingEntries, leaderCommit } = req.body;
    
    // [cite: 89] Append missing history
    log.push(...missingEntries);
    commitIndex = leaderCommit;

    // EDGE CASE FIX: Force frontend visual redraw for recovered strokes [cite: 141]
    missingEntries.forEach(entry => {
        axios.post(`${GATEWAY_URL}/broadcast`, { stroke: entry.stroke }).catch(() => {});
    });
    
    console.log(`[NODE ${REPLICA_ID}] Catch-up complete! Log size is now ${log.length}.`);
    res.json({ success: true }); // [cite: 90]
});

// Boot the node
app.listen(PORT, () => {
    console.log(`[NODE ${REPLICA_ID}] Booted on port ${PORT}. Status: ${state}`);
    resetElectionTimer(); 
});