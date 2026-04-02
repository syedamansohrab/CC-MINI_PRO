function getCommittedEntries(log, commitIndex) {
    if (!Array.isArray(log) || commitIndex < 0) {
        return [];
    }

    return log.slice(0, commitIndex + 1);
}

function normalizeEntry(entry, index) {
    if (!entry) {
        return null;
    }

    if (entry.type) {
        return entry;
    }

    if (entry.stroke) {
        const strokeId = entry.stroke.strokeId || `legacy-stroke-${index}`;
        return {
            ...entry,
            type: 'stroke',
            payload: {
                strokeId,
                stroke: { ...entry.stroke, strokeId }
            }
        };
    }

    return null;
}

function buildBoardState(log, commitIndex) {
    const entries = getCommittedEntries(log, commitIndex);
    const strokeById = new Map();
    const strokeOrder = [];
    const activeStack = [];
    const redoStack = [];

    entries.forEach((rawEntry, index) => {
        const entry = normalizeEntry(rawEntry, index);

        if (!entry) {
            return;
        }

        if (entry.type === 'stroke') {
            const strokeId = entry.payload?.strokeId;
            const stroke = entry.payload?.stroke;

            if (!strokeId || !stroke) {
                return;
            }

            strokeById.set(strokeId, { ...stroke, strokeId });
            strokeOrder.push(strokeId);
            activeStack.push(strokeId);
            redoStack.length = 0;
            return;
        }

        if (entry.type === 'undo') {
            const targetStrokeId = entry.payload?.targetStrokeId;
            const activeIndex = activeStack.lastIndexOf(targetStrokeId);

            if (activeIndex === -1) {
                return;
            }

            activeStack.splice(activeIndex, 1);
            redoStack.push(targetStrokeId);
            return;
        }

        if (entry.type === 'redo') {
            const targetStrokeId = entry.payload?.targetStrokeId;
            const redoIndex = redoStack.lastIndexOf(targetStrokeId);

            if (redoIndex === -1 || !strokeById.has(targetStrokeId)) {
                return;
            }

            redoStack.splice(redoIndex, 1);
            activeStack.push(targetStrokeId);
        }
    });

    const visibleStrokeIds = new Set(activeStack);
    const visibleStrokes = strokeOrder
        .filter((strokeId) => visibleStrokeIds.has(strokeId))
        .map((strokeId) => strokeById.get(strokeId));

    return {
        visibleStrokes,
        canUndo: activeStack.length > 0,
        canRedo: redoStack.length > 0,
        undoTargetStrokeId: activeStack.length > 0 ? activeStack[activeStack.length - 1] : null,
        redoTargetStrokeId: redoStack.length > 0 ? redoStack[redoStack.length - 1] : null,
        totalOperations: entries.length
    };
}

module.exports = {
    buildBoardState
};
