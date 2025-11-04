export interface MessageRecord {
  channel: string;
  ts: string; // main message ts
  thread_ts: string; // thread message ts
  // Last sent plaintext bodies to allow duplicate suppression
  last_main?: string;
  last_thread?: string;
}

// In-memory capped storage (stateless). Evicts oldest when size exceeds max.
export class Storage {
  private cache = new Map<string, MessageRecord>();
  private maxEntries: number;

  constructor(maxEntries: number = parseInt(process.env.STORAGE_MAX_ENTRIES ?? "500", 10)) {
    this.maxEntries = maxEntries;
  }

  get(key: string): MessageRecord | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: MessageRecord) {
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      // Evict oldest (FIFO by insertion order of Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key: string) {
    this.cache.delete(key);
  }

  size() {
    return this.cache.size;
  }
}
