/**
 * Undo journal for the simulator's state. Every mutation of a {@link JMap} records how to undo it,
 * so a reverted call, a failed validation or a reorg can restore the exact previous state. Values
 * must be treated as immutable: replace records instead of mutating them in place.
 */
export class Journal {
  private undo: (() => void)[] = [];

  /** Position to return to with {@link revertTo}. */
  mark(): number {
    return this.undo.length;
  }

  record(fn: () => void): void {
    this.undo.push(fn);
  }

  /** Undo every change recorded after `mark`, newest first. */
  revertTo(mark: number): void {
    while (this.undo.length > mark) {
      const fn = this.undo.pop();
      if (fn) fn();
    }
  }

  /** Take the changes recorded after `mark` out of the journal (they can be undone later, newest first). */
  splice(mark: number): (() => void)[] {
    return this.undo.splice(mark);
  }
}

/** Undo a list of changes taken with {@link Journal.splice}. */
export function undoAll(changes: readonly (() => void)[]): void {
  for (let i = changes.length - 1; i >= 0; i--) changes[i]?.();
}

/** A Map whose writes are journaled. */
export class JMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly journal: Journal) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    const had = this.map.has(key);
    const previous = this.map.get(key);
    this.map.set(key, value);
    this.journal.record(() => {
      if (had) this.map.set(key, previous as V);
      else this.map.delete(key);
    });
  }

  delete(key: K): void {
    if (!this.map.has(key)) return;
    const previous = this.map.get(key) as V;
    this.map.delete(key);
    this.journal.record(() => this.map.set(key, previous));
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }
}
