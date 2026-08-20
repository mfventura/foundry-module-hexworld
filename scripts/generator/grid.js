/**
 * WorldGrid — the spatial backbone of the generator.
 *
 * Instead of reimplementing hex/square math, we instantiate the same
 * foundry.grid.* classes a Scene would use for the chosen grid type and size.
 * That guarantees the rendered map image aligns pixel-perfect with the grid
 * Foundry draws on the created scene, and gives us correct cell adjacency
 * (including hex row-parity) for free.
 *
 * Cells are addressed by offset coordinates {i: row, j: column} and stored
 * flat as index = i * cols + j.
 */

function createFoundryGrid(type, size) {
  const T = CONST.GRID_TYPES;
  if (type === T.SQUARE) return new foundry.grid.SquareGrid({ size });
  const columns = (type === T.HEXODDQ) || (type === T.HEXEVENQ);
  const even = (type === T.HEXEVENR) || (type === T.HEXEVENQ);
  return new foundry.grid.HexagonalGrid({ size, columns, even });
}


export class WorldGrid {
  /**
   * @param {object} opts
   * @param {number} opts.type     CONST.GRID_TYPES value
   * @param {number} opts.size     grid space size in pixels
   * @param {number} opts.cols
   * @param {number} opts.rows
   */
  constructor({ type, size, cols, rows }) {
    this.type = type;
    this.size = size;
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.foundryGrid = createFoundryGrid(type, size);

    const n = this.n;
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    /** @type {Float64Array[]} flattened [x0,y0,x1,y1,...] polygon per cell */
    this.polys = new Array(n);
    /** @type {Int32Array[]} neighbor indices per cell */
    this.neighbors = new Array(n);

    let maxX = 0, maxY = 0;
    const g = this.foundryGrid;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const center = g.getCenterPoint({ i, j });
        this.cx[idx] = center.x;
        this.cy[idx] = center.y;
        const verts = g.getVertices({ i, j });
        const flat = new Float64Array(verts.length * 2);
        for (let k = 0; k < verts.length; k++) {
          flat[k * 2] = verts[k].x;
          flat[k * 2 + 1] = verts[k].y;
          if (verts[k].x > maxX) maxX = verts[k].x;
          if (verts[k].y > maxY) maxY = verts[k].y;
        }
        this.polys[idx] = flat;

        // v14 offsets may carry a third `k` (elevation) component — we work in
        // 2D, so ignore it and dedupe by (i, j).
        const adj = g.getAdjacentOffsets({ i, j });
        const nbs = new Set();
        for (const o of adj) {
          if (o.i >= 0 && o.i < rows && o.j >= 0 && o.j < cols && !(o.i === i && o.j === j)) {
            nbs.add(o.i * cols + o.j);
          }
        }
        this.neighbors[idx] = Int32Array.from(nbs);
      }
    }
    this.pixelWidth = Math.ceil(maxX);
    this.pixelHeight = Math.ceil(maxY);
  }

  index(i, j) { return i * this.cols + j; }

  rowOf(idx) { return Math.floor(idx / this.cols); }

  colOf(idx) { return idx % this.cols; }

  isBorder(idx) {
    const i = this.rowOf(idx), j = this.colOf(idx);
    return i === 0 || j === 0 || i === this.rows - 1 || j === this.cols - 1;
  }

  /** Latitude fraction of a cell: 0 at the top row, 1 at the bottom row. */
  latFrac(idx) {
    return this.rows > 1 ? this.rowOf(idx) / (this.rows - 1) : 0.5;
  }
}
