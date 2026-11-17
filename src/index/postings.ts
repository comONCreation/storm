// Compressed posting lists (trigram → sorted file ids).
//
// Ids are stored as varint-encoded gaps: dense lists ("the", "fun"…) cost
// ~1 byte per id instead of 4. The store has two parts, like a tiny Lucene:
//
//  - an immutable *base segment*: four flat typed arrays (sorted keys, byte
//    offsets, counts, data). It is loaded from disk in one block, without
//    creating an object per trigram;
//  - a *delta*: the trigram set of each file indexed since the last rebuild,
//    kept as is (one typed array per file). Adding a file is O(1): no per
//    trigram hash-map work, which used to dominate indexing time.
//
// rebuild() turns the delta into posting lists with a counting sort over the
// 24-bit trigram space, merges them with the base, drops deleted files and
// renumbers the survivors. File ids only grow, so delta ids are always larger
// than base ids and every list stays sorted.

export class ByteWriter {
  buf: Uint8Array;
  len = 0;
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }
  ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(this.buf.subarray(0, this.len));
    this.buf = bigger;
  }
  varint(v: number) {
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }
}

/** Decodes `n` gap-encoded ids from data[start..]. */
export function decodeIds(data: Uint8Array, start: number, n: number, out = new Uint32Array(n), outOffset = 0): Uint32Array {
  let p = start;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    let mul = 1;
    let b: number;
    do {
      b = data[p++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    acc = i === 0 ? v : acc + v;
    out[outOffset + i] = acc;
  }
  return out;
}

interface Base {
  keys: Uint32Array; // sorted trigrams
  offs: Uint32Array; // byte offset of each list in data (length = keys + 1)
  counts: Uint32Array; // number of ids of each list
  data: Uint8Array;
}

const EMPTY = new Uint32Array(0);
const TRIGRAM_SPACE = 1 << 24;

const emptyBase = (): Base => ({ keys: new Uint32Array(0), offs: new Uint32Array(1), counts: new Uint32Array(0), data: new Uint8Array(0) });

export class PostingStore {
  private base: Base = emptyBase();
  /** Delta: ids (increasing) and the trigram set of each recently indexed file. */
  private deltaIds: number[] = [];
  private deltaTris: Uint32Array[] = [];
  private deltaPairs = 0;

  private find(t: number): number {
    const keys = this.base.keys;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = keys[mid];
      if (k < t) lo = mid + 1;
      else if (k > t) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  /** Registers the (distinct) trigrams of a newly indexed file. Ids must be increasing. */
  addDoc(id: number, trigrams: Uint32Array) {
    this.deltaIds.push(id);
    this.deltaTris.push(trigrams);
    this.deltaPairs += trigrams.length;
  }

  /** Sorted ids of the files containing trigram t. */
  ids(t: number): Uint32Array {
    const i = this.find(t);
    const nb = i >= 0 ? this.base.counts[i] : 0;
    // The delta is scanned with the native TypedArray#indexOf: it only holds
    // files indexed since the last rebuild, which is kept at most the base size.
    let fromDelta: number[] | null = null;
    for (let k = 0; k < this.deltaTris.length; k++) {
      if (this.deltaTris[k].indexOf(t) >= 0) (fromDelta ??= []).push(this.deltaIds[k]);
    }
    const nd = fromDelta ? fromDelta.length : 0;
    if (nb + nd === 0) return EMPTY;
    const out = new Uint32Array(nb + nd);
    if (nb) decodeIds(this.base.data, this.base.offs[i], nb, out, 0);
    if (nd) out.set(fromDelta!, nb);
    return out;
  }

  /** Number of distinct trigrams in the base segment (the delta is merged regularly). */
  get trigramCount() {
    return this.base.keys.length;
  }

  /** Number of files waiting in the delta. */
  get pendingDocs() {
    return this.deltaIds.length;
  }

  /** Approximate number of bytes held by the delta. */
  get pendingBytes() {
    return this.deltaPairs * 4 + this.deltaIds.length * 64;
  }

  clear() {
    this.base = emptyBase();
    this.deltaIds = [];
    this.deltaTris = [];
    this.deltaPairs = 0;
  }

  /**
   * Merges base and delta into a new base. `remap[oldId]` gives the new id of
   * each file, or -1 for a deleted / outdated one (remap must be monotonic).
   */
  rebuild(remap: Int32Array) {
    const old = this.base;

    // 1. Counting sort of the delta (trigram, id) pairs by trigram. Files are
    //    visited in id order, so ids come out sorted within each trigram.
    let pos: Uint32Array | null = null;
    let sortedIds: Uint32Array | null = null;
    if (this.deltaPairs > 0) {
      pos = new Uint32Array(TRIGRAM_SPACE);
      for (const tris of this.deltaTris) for (let x = 0; x < tris.length; x++) pos[tris[x]]++;
      let acc = 0;
      for (let t = 0; t < TRIGRAM_SPACE; t++) {
        const c = pos[t];
        pos[t] = acc;
        acc += c;
      }
      sortedIds = new Uint32Array(this.deltaPairs);
      for (let k = 0; k < this.deltaTris.length; k++) {
        const tris = this.deltaTris[k];
        const id = this.deltaIds[k];
        for (let x = 0; x < tris.length; x++) sortedIds[pos[tris[x]]++] = id;
      }
      // now pos[t] = end of t's slice, and its start is pos[t - 1] (or 0)
    }

    // 2. Merge base lists and delta slices in trigram order, remapping ids.
    const maxKeys = old.keys.length + (pos ? Math.min(this.deltaPairs, TRIGRAM_SPACE) : 0);
    let keys = new Uint32Array(Math.min(maxKeys, TRIGRAM_SPACE));
    let counts = new Uint32Array(keys.length);
    let offs = new Uint32Array(keys.length + 1);
    const w = new ByteWriter(old.data.length + Math.ceil(this.deltaPairs * 1.5) + 1024);
    let k = 0;
    let scratch = new Uint32Array(1024);

    const emit = (t: number, nb: number, bi: number, dStart: number, dEnd: number) => {
      if (nb) {
        if (scratch.length < nb) scratch = new Uint32Array(Math.max(nb, scratch.length * 2));
        decodeIds(old.data, old.offs[bi], nb, scratch, 0);
      }
      const start = w.len;
      let prev = 0;
      let count = 0;
      // Worst case 5 bytes per id: reserve once, then write varints inline (hot loop).
      w.ensure((nb + dEnd - dStart) * 5);
      const buf = w.buf;
      let len = w.len;
      for (let pass = 0; pass < 2; pass++) {
        const src = pass === 0 ? scratch : sortedIds!;
        const from = pass === 0 ? 0 : dStart;
        const to = pass === 0 ? nb : dEnd;
        for (let x = from; x < to; x++) {
          const nid = remap[src[x]];
          if (nid === undefined || nid < 0) continue;
          let v = count === 0 ? nid : nid - prev;
          while (v >= 0x80) {
            buf[len++] = (v & 0x7f) | 0x80;
            v >>>= 7;
          }
          buf[len++] = v;
          prev = nid;
          count++;
        }
      }
      w.len = len;
      if (count === 0) {
        w.len = start;
        return;
      }
      if (k === keys.length) {
        // more distinct keys than estimated: grow
        const grow = (a: Uint32Array, n: number) => {
          const b = new Uint32Array(n);
          b.set(a);
          return b;
        };
        keys = grow(keys, keys.length * 2 + 16);
        counts = grow(counts, keys.length);
        offs = grow(offs, keys.length + 1);
      }
      keys[k] = t;
      counts[k] = count;
      offs[k] = start;
      k++;
    };

    let bi = 0;
    if (pos) {
      let prevEnd = 0;
      for (let t = 0; t < TRIGRAM_SPACE; t++) {
        const end = pos[t];
        const hasDelta = end > prevEnd;
        // flush base keys smaller than t
        while (bi < old.keys.length && old.keys[bi] < t) {
          emit(old.keys[bi], old.counts[bi], bi, 0, 0);
          bi++;
        }
        const inBase = bi < old.keys.length && old.keys[bi] === t;
        if (hasDelta || inBase) {
          emit(t, inBase ? old.counts[bi] : 0, bi, prevEnd, end);
          if (inBase) bi++;
        }
        prevEnd = end;
      }
    }
    while (bi < old.keys.length) {
      emit(old.keys[bi], old.counts[bi], bi, 0, 0);
      bi++;
    }
    offs[k] = w.len;
    this.base = {
      keys: keys.slice(0, k),
      offs: offs.slice(0, k + 1),
      counts: counts.slice(0, k),
      data: w.buf.slice(0, w.len),
    };
    this.deltaIds = [];
    this.deltaTris = [];
    this.deltaPairs = 0;
  }

  /** Serialises the base segment (call rebuild() first so that the delta is empty). */
  serialize(): Buffer[] {
    const b = this.base;
    const n = b.keys.length;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(n, 0);
    const view = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    return [head, view(b.keys), view(b.offs), view(b.counts), view(b.data)];
  }

  /** Loads a base segment written by serialize(), starting at `offset` in `buf`. */
  load(buf: Buffer, offset: number) {
    const n = buf.readUInt32LE(offset);
    // One copy of the postings section, 4-byte aligned, then zero-copy views on it.
    const section = buf.buffer.slice(buf.byteOffset + offset + 4, buf.byteOffset + buf.length);
    const keys = new Uint32Array(section, 0, n);
    const offs = new Uint32Array(section, 4 * n, n + 1);
    const counts = new Uint32Array(section, 4 * (2 * n + 1), n);
    const data = new Uint8Array(section, 4 * (3 * n + 1), offs[n]);
    this.base = { keys, offs, counts, data };
    this.deltaIds = [];
    this.deltaTris = [];
    this.deltaPairs = 0;
  }
}

/** Intersects sorted id lists, smallest first. */
export function intersect(lists: Uint32Array[]): Uint32Array {
  if (!lists.length) return new Uint32Array(0);
  lists.sort((x, y) => x.length - y.length);
  let acc = lists[0];
  for (let k = 1; k < lists.length && acc.length; k++) {
    const other = lists[k];
    const out = new Uint32Array(acc.length);
    let n = 0;
    let j = 0;
    for (let i = 0; i < acc.length; i++) {
      const v = acc[i];
      if (other.length > acc.length * 8) {
        let lo = j;
        let hi = other.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (other[mid] < v) lo = mid + 1;
          else hi = mid;
        }
        j = lo;
      } else {
        while (j < other.length && other[j] < v) j++;
      }
      if (j < other.length && other[j] === v) out[n++] = v;
    }
    acc = out.subarray(0, n);
  }
  return acc;
}
