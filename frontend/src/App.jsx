import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

// Connect directly to our Gateway container on port 8080
const socket = io('http://localhost:8080');

function App() {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });

  // 1. Listen for strokes coming from the RAFT cluster
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    socket.on('draw-stroke', (stroke) => {
      ctx.lineWidth = stroke.thickness || 2;
      ctx.strokeStyle = stroke.color || '#000000';

      ctx.beginPath();
      ctx.moveTo(stroke.startX, stroke.startY);
      ctx.lineTo(stroke.endX, stroke.endY);
      ctx.stroke();
    });

    return () => socket.off('draw-stroke');
  }, []);

  // 2. Mouse Event Handlers
  const startDrawing = (e) => {
    setIsDrawing(true);
    setLastPos({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });
  };

  const draw = (e) => {
    if (!isDrawing) return;

    const currentX = e.nativeEvent.offsetX;
    const currentY = e.nativeEvent.offsetY;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';

    // Draw locally for zero-latency visual feedback
    ctx.beginPath();
    ctx.moveTo(lastPos.x, lastPos.y);
    ctx.lineTo(currentX, currentY);
    ctx.stroke();

    // 3. Send the stroke coordinates to the Gateway
    socket.emit('send-stroke', {
      startX: lastPos.x,
      startY: lastPos.y,
      endX: currentX,
      endY: currentY,
      color: '#000000',
      thickness: 2
    });

    setLastPos({ x: currentX, y: currentY });
  };

  const stopDrawing = () => setIsDrawing(false);

  return (
    <div className="board-container">
      <h2>Distributed Whiteboard (Mini-RAFT)</h2>
      <p>Draw below. Strokes are validated by the Replica Cluster!</p>
      
      <canvas
        ref={canvasRef}
        width={800}
        height={500}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseOut={stopDrawing}
        style={{ 
          border: '2px solid #333', 
          backgroundColor: '#ffffff',
          cursor: 'crosshair',
          boxShadow: '0 4px 8px rgba(0,0,0,0.1)'
        }}
      />
    </div>
  );
}

export default App;