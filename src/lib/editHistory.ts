export const maxHistoryDepth = 60;

export interface HistorySnapshot<T> {
  past: T[];
  present: T;
  future: T[];
}

export function pushPast<T>(past: T[], current: T): T[] {
  return [...past, current].slice(-maxHistoryDepth);
}

export function pushFuture<T>(future: T[], current: T): T[] {
  return [current, ...future].slice(0, maxHistoryDepth);
}

export function undoStep<T>(past: T[], future: T[], current: T): HistorySnapshot<T> | null {
  if (past.length === 0) {
    return null;
  }

  return {
    past: past.slice(0, -1),
    present: past[past.length - 1],
    future: pushFuture(future, current),
  };
}

export function redoStep<T>(past: T[], future: T[], current: T): HistorySnapshot<T> | null {
  if (future.length === 0) {
    return null;
  }

  return {
    past: pushPast(past, current),
    present: future[0],
    future: future.slice(1),
  };
}
