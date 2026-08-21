/**
 * Shared Node mocks for the smoke tests: a square foundry.grid implementation
 * with the same surface the generator uses (getCenterPoint, getVertices,
 * getAdjacentOffsets, getOffset). Import this BEFORE importing any module
 * from scripts/ (static imports are hoisted, so a plain `import "./mock-foundry.mjs"`
 * at the top works).
 */

globalThis.CONST = { GRID_TYPES: { SQUARE: 1, HEXODDR: 2, HEXEVENR: 3, HEXODDQ: 4, HEXEVENQ: 5 } };

globalThis.foundry = {
  grid: {
    SquareGrid: class {
      constructor({ size }) { this.size = size; }
      getCenterPoint({ i, j }) { return { x: (j + 0.5) * this.size, y: (i + 0.5) * this.size }; }
      getVertices({ i, j }) {
        const s = this.size;
        return [
          { x: j * s, y: i * s }, { x: (j + 1) * s, y: i * s },
          { x: (j + 1) * s, y: (i + 1) * s }, { x: j * s, y: (i + 1) * s }
        ];
      }
      getAdjacentOffsets({ i, j }) {
        const out = [];
        for (let a = -1; a <= 1; a++) {
          for (let b = -1; b <= 1; b++) {
            if (a || b) out.push({ i: i + a, j: j + b, k: 0 });
          }
        }
        return out;
      }
      getOffset({ x, y }) {
        return { i: Math.floor(y / this.size), j: Math.floor(x / this.size) };
      }
    },
    HexagonalGrid: class {}
  }
};
