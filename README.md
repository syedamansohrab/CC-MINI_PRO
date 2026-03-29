# Distributed Real-Time Drawing Board (Mini-RAFT)

A cloud-native, fault-tolerant collaborative whiteboard built with React, Node.js, and WebSockets. This system is backed by a 3-node replica cluster utilizing a custom **Mini-RAFT consensus algorithm** to guarantee state consistency, zero-downtime failovers, and resilient log replication.

## 🚀 System Architecture
- **Frontend:** React + HTML5 Canvas (Vite)
- **Gateway:** Node.js + Socket.io WebSocket server
- **Replica Cluster:** 3 Node.js containers operating as a RAFT state machine (Follower, Candidate, Leader)
- **Infrastructure:** Docker Compose with isolated bridge networking and hot-reload volume mounts.

## ✨ Key Features
- **Leader Election:** Randomized timeouts (500-800ms) with strict term-based voting.
- **Log Replication:** Stroke data requires a majority quorum (≥ 2 nodes) to commit.
- **Zero-Downtime Failover:** If the leader crashes, the cluster autonomously elects a new leader and the Gateway instantly re-routes traffic.
- **Catch-Up Protocol (`/sync-log`):** Restarted or lagged nodes automatically fetch missing history from the leader and trigger UI redraws to ensure absolute state consistency.

---

## 🛠️ Prerequisites
- **Docker Desktop** (Make sure WSL 2 integration is enabled in Docker settings).
- **WSL (Windows Subsystem for Linux):** Recommended to use Ubuntu. Do not run this from a standard Windows Command Prompt or PowerShell to avoid file path and execution policy errors.
- *Note: You do not need Node.js installed locally; Docker handles all environments and dependencies.*

---

## 🏃‍♂️ Step-by-Step Execution Guide

### 1. Open your WSL Terminal
Open your Ubuntu/WSL terminal. Do all of the following steps inside this Linux environment.

### 2. Clone the Repository
```bash
git clone [https://github.com/syedamansohrab/CC-MINI_PRO.git](https://github.com/syedamansohrab/CC-MINI_PRO.git)
cd CC-MINI_PRO
```

### 3. Fix File Permissions (Windows/WSL specific)
Because Docker creates containers as the Linux `root` user, bind-mounted volumes can sometimes cause permission denied (`EACCES`) errors when editing files locally. Run this command to ensure your WSL user owns all the project files:
```bash
sudo chown -R $(id -u):$(id -g) .
```

### 4. Boot the Cluster
Wipe any old, corrupted Docker volumes and boot the Gateway, all 3 Replicas, and the Frontend simultaneously:
```bash
docker-compose down -v
docker-compose up
```

### 5. Access the Application
1. Watch the terminal logs. Wait until you see a log that looks like this:
   `👑 [NODE X] is now the LEADER for Term Y! 👑`
2. Once the leader is elected, open **two or more separate browser windows** and navigate to:
   👉 **http://localhost:5173**
3. Draw in one window and watch it sync across the cluster in real-time!

---

## 🧪 Testing Fault Tolerance & Chaos Recovery

To verify the distributed consensus logic, keep your browser windows visible and open a **second WSL terminal tab** in the project directory.

### Test 1: Leader Failover (Zero Downtime)
1. Find out which node is currently the Leader from the main terminal logs.
2. Assassinate the leader using its container name:
   ```bash
   docker stop mini_pro-replica1-1  # Replace '1' with the actual leader's ID
   ```
3. **Verify:** Watch the main terminal. The remaining two nodes will hit their timeout, hold a rapid election, and crown a new leader. Continue drawing in the browser—the Gateway will seamlessly route your strokes to the new boss.

### Test 2: Catch-Up Protocol
1. While that node is still dead, draw 3 or 4 distinct shapes on the canvas.
2. Resurrect the dead node:
   ```bash
   docker start mini_pro-replica1-1
   ```
3. **Verify:** The node will wake up, realize it missed the strokes, and call the `/sync-log` endpoint. You will see `Catch-up complete!` in the logs, and those missing strokes will instantly flash onto that node's internal state (and broadcast a visual redraw).

### Test 3: Hot-Reloading (Blue-Green Updates)
1. Open the source code for one of the active backend replicas (e.g., `replica3/index.js`) in VS Code.
2. Add a simple comment like `// testing reload` at the bottom of the file and save it (`Ctrl+S`).
3. **Verify:** Nodemon will instantly restart that specific container. Because the other 2 nodes still form a majority quorum, users can continue drawing on the canvas without ever noticing a server went down for an update!