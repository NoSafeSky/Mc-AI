class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, handler) {
    if (!eventName || typeof handler !== "function") return () => {};
    const key = String(eventName);
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    const set = this.listeners.get(key);
    set.add(handler);
    return () => this.off(key, handler);
  }

  once(eventName, handler) {
    if (typeof handler !== "function") return () => {};
    const off = this.on(eventName, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(eventName, handler) {
    const key = String(eventName || "");
    if (!key || !this.listeners.has(key)) return;
    const set = this.listeners.get(key);
    set.delete(handler);
    if (set.size < 1) this.listeners.delete(key);
  }

  emit(eventName, payload = {}) {
    const key = String(eventName || "");
    if (!key) return;
    const set = this.listeners.get(key);
    if (!set || set.size < 1) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {}
    }
  }
}

module.exports = { EventBus };

