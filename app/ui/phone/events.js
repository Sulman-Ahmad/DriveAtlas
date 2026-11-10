// Live updates inside the phone app, with the same shape as the PC's EventSource, so the screens
// subscribe the same way on both: openEvents().addEventListener('catalog', (e) => JSON.parse(e.data)).
const handlers = new Map();

export function emit(type, data) {
  const event = { type, data: JSON.stringify(data ?? {}) };
  for (const cb of [...(handlers.get(type) || [])]) {
    try { cb(event); } catch (err) { console.error(err); }
  }
}

export function openEvents() {
  const mine = [];
  return {
    addEventListener(type, cb) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(cb);
      mine.push([type, cb]);
    },
    close() {
      for (const [type, cb] of mine) handlers.get(type)?.delete(cb);
      mine.length = 0;
    }
  };
}
