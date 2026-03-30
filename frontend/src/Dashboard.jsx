import React, { useState, useEffect } from 'react';

const Dashboard = () => {
  const [nodes, setNodes] = useState([]);

  useEffect(() => {
    // Poll the gateway every 1 second for fresh cluster data
    const interval = setInterval(() => {
      fetch('http://localhost:8080/cluster-status')
        .then(res => res.json())
        .then(data => setNodes(data))
        .catch(err => console.error("Dashboard fetch error:", err));
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace', backgroundColor: '#1e1e1e', color: '#fff', borderRadius: '8px', marginBottom: '20px' }}>
      <h2 style={{ textAlign: 'center', margin: '0 0 20px 0' }}>🖥️ Mini-RAFT Cluster Dashboard</h2>
      
      <div style={{ display: 'flex', gap: '15px', justifyContent: 'center' }}>
        {nodes.map((node) => {
          // Highlight the Leader in green, Candidate in yellow, Follower in blue, Offline in red
          let borderColor = '#444';
          if (node.state === 'Leader') borderColor = '#4CAF50';
          if (node.state === 'Candidate') borderColor = '#FFC107';
          if (node.state === 'Follower') borderColor = '#2196F3';
          if (node.state.includes('Offline')) borderColor = '#F44336';

          return (
            <div key={node.id} style={{
              border: `3px solid ${borderColor}`,
              padding: '15px',
              borderRadius: '8px',
              width: '200px',
              backgroundColor: '#2d2d2d'
            }}>
              <h3 style={{ margin: '0 0 10px 0', borderBottom: '1px solid #444', paddingBottom: '5px' }}>
                Node {node.id}
              </h3>
              <p><strong>State:</strong> {node.state}</p>
              <p><strong>Term:</strong> {node.term}</p>
              <p><strong>Log Size:</strong> {node.logSize}</p>
              <p><strong>Commit Idx:</strong> {node.commitIndex}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Dashboard;