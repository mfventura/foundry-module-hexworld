/**
 * Binary min-heap keyed by a numeric priority captured at push time.
 * Shared by the priority-flood (hydrology) and Dijkstra (sites) passes.
 */
export class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }

  get size() {
    return this.v.length;
  }

  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key);
    v.push(val);
    let c = v.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (k[p] <= k[c]) break;
      [k[p], k[c]] = [k[c], k[p]];
      [v[p], v[c]] = [v[c], v[p]];
      c = p;
    }
  }

  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (v.length) {
      k[0] = lk;
      v[0] = lv;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < v.length && k[l] < k[m]) m = l;
        if (r < v.length && k[r] < k[m]) m = r;
        if (m === c) break;
        [k[m], k[c]] = [k[c], k[m]];
        [v[m], v[c]] = [v[c], v[m]];
        c = m;
      }
    }
    return top;
  }
}
