import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import Dashboard from './Dashboard';
import { drawStroke, redrawCanvas } from './canvasUtils';
import './App.css';

const socket = io('http://localhost:8080');

function App() {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });
  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
    totalOperations: 0,
  });

  useEffect(() => {
    const handleBoardState = (boardState) => {
      setHistoryState({
        canUndo: boardState.canUndo,
        canRedo: boardState.canRedo,
        totalOperations: boardState.totalOperations,
      });

      redrawCanvas(canvasRef.current, boardState.visibleStrokes || []);
    };

    socket.on('board-state', handleBoardState);

    return () => socket.off('board-state', handleBoardState);
  }, []);

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

    drawStroke(ctx, {
      startX: lastPos.x,
      startY: lastPos.y,
      endX: currentX,
      endY: currentY,
      color: '#000000',
      thickness: 2,
    });

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
      <Dashboard />
      <h2>Distributed Whiteboard (Mini-RAFT)</h2>
      <p>Draw below. Strokes, undo, and redo are committed through the replica cluster.</p>

      <div className="toolbar">
        <button type="button" onClick={() => socket.emit('undo')} disabled={!historyState.canUndo}>
          Undo
        </button>
        <button type="button" onClick={() => socket.emit('redo')} disabled={!historyState.canRedo}>
          Redo
        </button>
        <span className="history-status">Committed Ops: {historyState.totalOperations}</span>
      </div>

      <canvas
        ref={canvasRef}
        width={800}
        height={500}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseOut={stopDrawing}
        className="board-canvas"
      />
    </div>
  );
}

export default App;
