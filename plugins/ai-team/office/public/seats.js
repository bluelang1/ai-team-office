// AI Team Office v3 — seat book: who sits where, per room. Pure (no DOM) so it can be unit-tested.
// Seats are fixed indices per room. When a room is full, extra agents get an overflow standing spot; both are
// taken from free sets (lowest free index first), so a spot freed in the middle is reused without stacking two
// agents on one spot. When a seat frees up, the longest-waiting overflow agent in that room is promoted to it.

export class SeatBook {
  /** counts: { room: number of seats }. reserved(room) -> seat indices that only their reducer owner may take. */
  constructor(counts, reserved = () => []) { this.counts = counts; this.reserved = reserved; this.reset(); }
  reset() { this.owner = new Map(); this.of = new Map(); this.over = new Map(); this.seq = 0; }
  /** Current place of `id`: { room, i } (seat) | { room, over: k } (standing spot) | undefined. */
  get(id) { return this.of.get(id); }
  /** Seat `id` in `room`. force: a seat index this agent owns outright (the reducer's desk); it evicts a leftover. */
  claim(id, room, opts = {}) {
    const cur = this.of.get(id);
    if (cur && cur.room === room && (opts.force == null || cur.i === opts.force)) return cur;
    this.release(id, { promote: !(cur && cur.room === room) });
    if (opts.force != null) {
      const k = `${room}:${opts.force}`, old = this.owner.get(k);
      if (old && old !== id) { this.of.delete(old); this.claim(old, room); }      // the leftover moves on, not lost
      return this.#sit(id, room, opts.force);
    }
    const n = this.counts[room] || 0, res = new Set(this.reserved(room));
    for (let i = 0; i < n; i++) if (!res.has(i) && !this.owner.has(`${room}:${i}`)) return this.#sit(id, room, i);
    const taken = this.over.get(room) || new Map();
    let k = 0; while ([...taken.values()].some(v => v.k === k)) k++;
    taken.set(id, { k, t: ++this.seq }); this.over.set(room, taken);
    const s = { room, over: k }; this.of.set(id, s); return s;
  }
  /** Free `id`'s seat or spot. With promote (default), the longest-waiting stander in that room takes the seat. */
  release(id, { promote = true } = {}) {
    const s = this.of.get(id);
    if (!s) return null;
    this.of.delete(id);
    if (s.over != null) { this.over.get(s.room)?.delete(id); return null; }
    this.owner.delete(`${s.room}:${s.i}`);
    if (!promote || new Set(this.reserved(s.room)).has(s.i)) return null;
    const wait = this.over.get(s.room);
    if (!wait?.size) return null;
    const [next] = [...wait.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    wait.delete(next);
    this.#sit(next, s.room, s.i);
    return next;                                         // caller re-targets this agent
  }
  /** Seat keys `room:i` currently owned. */
  keys() { return this.owner.entries(); }
  #sit(id, room, i) { this.owner.set(`${room}:${i}`, id); const s = { room, i }; this.of.set(id, s); return s; }
}
