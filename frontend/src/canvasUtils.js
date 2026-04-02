export function drawStroke(ctx, stroke) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = stroke.thickness || 2
  ctx.strokeStyle = stroke.color || '#000000'

  ctx.beginPath()
  ctx.moveTo(stroke.startX, stroke.startY)
  ctx.lineTo(stroke.endX, stroke.endY)
  ctx.stroke()
}

export function redrawCanvas(canvas, strokes) {
  if (!canvas) {
    return
  }

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  strokes.forEach((stroke) => {
    drawStroke(ctx, stroke)
  })
}
