// Minimal Node EventEmitter for the web bundle (node-cache extends it).
type Listener = (...args: unknown[]) => void;
export class EventEmitter {
  private listeners = new Map<string | symbol, Listener[]>();
  on(event: string | symbol, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }
  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string | symbol, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }
  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }
  emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.listeners.get(event) ?? [];
    for (const listener of listeners) listener(...args);
    return listeners.length > 0;
  }
}
export default EventEmitter;
(EventEmitter as unknown as { EventEmitter: typeof EventEmitter }).EventEmitter = EventEmitter;
