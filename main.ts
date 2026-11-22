// Sokoban solver: push-optimal, room by room.
// Written from scratch for make.fun's sokoban-solver-01-run-20261121.
// Idea: every generated level is a hallway plus 1-4 rooms, each holding 3-4
// boxes and as many goals, and a box pushed out of a room through its door
// can never come back. So the push-optimal count of a level is the sum of
// its rooms' push-optima. We solve each room on its own with A* over push
// states (admissible assignment heuristic + dead-square pruning), then stitch
// the rooms together with plain walking moves through the hallway. Walking
// costs no pushes, so the stitched solution is push-optimal for the level.
// The search budget is counted in node expansions, never wall-clock time,
// so two runs of the program produce byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Expansion budgets (node counts, deterministic). A room is at most a 6x6
// slot with 3-4 boxes, so plain A* normally finishes far below the cap;
// the weighted and greedy passes are only a safety net that still returns
// a valid (if not push-optimal) solution instead of nothing.
const ASTAR_CAP = 600_000;
const WEIGHTED_CAP = 1_200_000;
const GREEDY_CAP = 1_200_000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' }, // 0: up    (opposite is 1)
  { dx: 0, dy: 1, ch: 'd' }, // 1: down  (opposite is 0)
  { dx: -1, dy: 0, ch: 'l' }, // 2: left  (opposite is 3)
  { dx: 1, dy: 0, ch: 'r' }, // 3: right (opposite is 2)
] as const; // NOTE: opposites pair as (0,1) and (2,3), so the opposite of d is d ^ 1.

const idx = (x: number, y: number, w: number): number => y * w + x;

// ---------------------------------------------------------------- level ---

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall, indexed by cell
  goal: Uint8Array; // 1 = goal
  boxes: number[]; // initial box cells
  player: number; // initial player cell
};

function parseLevel(text: string): Level {
  const rows = text.replace(/\r/g, '').split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x] ?? '#';
      const cell = idx(x, y, w);
      if (c === '#') wall[cell] = 1;
      else if (c === '.') goal[cell] = 1;
      else if (c === '$') boxes.push(cell);
      else if (c === '*') { goal[cell] = 1; boxes.push(cell); }
      else if (c === '@') player = cell;
      else if (c === '+') { goal[cell] = 1; player = cell; }
    }
  }
  return { w, h, wall, goal, boxes, player };
}

// Breadth-first walk on the whole level. `blocked` marks cells the player
// may not step on (walls + boxes). Returns the move string from `from` to
// `to`, or null when unreachable.
function walkPath(
  level: Level,
  from: number,
  to: number,
  blocked: Uint8Array,
): string | null {
  if (from === to) return '';
  const { w, h, wall } = level;
  const prev = new Int32Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h).fill(-1);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d].dx;
      const ny = cy + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = idx(nx, ny, w);
      if (prev[n] !== -1 || wall[n] || blocked[n]) continue;
      prev[n] = cur;
      prevDir[n] = d;
      if (n === to) {
        let out = '';
        let c = n;
        while (c !== from) {
          out = DIRS[prevDir[c]].ch + out;
          c = prev[c];
        }
        return out;
      }
      queue.push(n);
    }
  }
  return null;
}

// ------------------------------------------------------------- rooms ------

type Room = {
  cells: number[]; // room cells, global indices, sorted, plus the entry cell last
  local: Map<number, number>; // global cell -> local index
  boxes: number[]; // initial box cells, local indices
  goals: number[]; // goal cells, local indices
  door: number; // door cell, local index (the room cell touching the hallway)
  entry: number; // entry cell, local index (the hallway cell touching the door)
  // A box can start ON the door cell, so the player enters the room from the
  // entry cell and may push that box inward from there. The entry cell is a
  // standing cell only: a box is never pushed onto it.
};

// Split the level into the hallway (the player's row) and the rooms hanging
// off it. Rooms are found as connected components of non-wall cells outside
// the hallway row.
function findRooms(level: Level): Room[] {
  const { w, h, wall, player } = level;
  const hallRow = (player / w) | 0;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = idx(x, y, w);
      if (wall[cell] || y === hallRow || seen[cell]) continue;
      // Flood-fill this component.
      const cells: number[] = [];
      const stack = [cell];
      seen[cell] = 1;
      while (stack.length > 0) {
        const c = stack.pop()!;
        cells.push(c);
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DIRS[d].dx;
          const ny = cy + DIRS[d].dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = idx(nx, ny, w);
          if (wall[n] || ny === hallRow || seen[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      cells.sort((a, b) => a - b);
      const local = new Map<number, number>();
      cells.forEach((c, i) => local.set(c, i));
      const boxes: number[] = [];
      const goals: number[] = [];
      for (const c of cells) {
        if (level.boxes.includes(c)) boxes.push(local.get(c)!);
        if (level.goal[c]) goals.push(local.get(c)!);
      }
      // The door is the room cell touching the hallway row, and the entry
      // is the hallway cell it touches.
      let door = -1;
      let entryGlobal = -1;
      for (const c of cells) {
        const cx = c % w;
        const cy = (c / w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DIRS[d].dx;
          const ny = cy + DIRS[d].dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (ny === hallRow && !wall[idx(nx, ny, w)]) { door = local.get(c)!; entryGlobal = idx(nx, ny, w); break; }
        }
        if (door !== -1) break;
      }
      if (door === -1) continue; // a pocket with no door is not a room
      // Append the entry cell to the room's cell set so the solver can
      // stand on it (and push a box off the door from it).
      const entry = cells.length;
      cells.push(entryGlobal);
      local.set(entryGlobal, entry);
      rooms.push({ cells, local, boxes, goals, door, entry });
    }
  }
  // Deterministic order: by door column, then by first cell.
  rooms.sort((a, b) => {
    const da = a.cells[a.door] % w;
    const db = b.cells[b.door] % w;
    return da !== db ? da - db : a.cells[0] - b.cells[0];
  });
  return rooms;
}

// ------------------------------------------------------- room solver ------

type Push = { box: number; dir: number }; // box local index, direction 0..3

// A* over push states for one room. Returns the push list, or null when the
// budget ran out. `weight` scales the heuristic: 1 is A*, higher is a
// weighted search that still returns a valid solution.
function solveRoom(
  room: Room,
  level: Level,
  weight: number,
  cap: number,
): Push[] | null {
  const n = room.cells.length;
  const { w } = level;
  // Local neighbours: nbr[local * 4 + dir], -1 when outside the room.
  const nbr = new Int32Array(n * 4).fill(-1);
  for (let i = 0; i < n; i++) {
    const g = room.cells[i];
    const gx = g % w;
    const gy = (g / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = gx + DIRS[d].dx;
      const ny = gy + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const j = room.local.get(idx(nx, ny, w));
      if (j !== undefined) nbr[i * 4 + d] = j;
    }
  }
  const isGoal = new Uint8Array(n);
  for (const g of room.goals) isGoal[g] = 1;

  // Push-distance tables: dist[goal][cell] = fewest pushes to move one box
  // alone from cell to goal (player position ignored, other boxes ignored).
  // Reverse BFS: a box on c could have been pushed there from p = c - dir
  // when the player could stand at p - dir.
  const INF = 1 << 28;
  const dist: Int32Array[] = [];
  for (const g of room.goals) {
    const table = new Int32Array(n).fill(INF);
    table[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      for (let d = 0; d < 4; d++) {
        const p = nbr[c * 4 + (d ^ 1)]; // cell the box was pushed from
        if (p === -1 || table[p] !== INF) continue;
        // The player must have stood one step further back to push it.
        const stand = nbr[p * 4 + (d ^ 1)];
        if (stand === -1) continue;
        table[p] = table[c] + 1;
        queue.push(p);
      }
    }
    dist.push(table);
  }
  // Dead cells: a box here can never reach any goal.
  const dead = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (isGoal[c]) continue;
    let reachable = false;
    for (const table of dist) if (table[c] !== INF) { reachable = true; break; }
    if (!reachable) dead[c] = 1;
  }

  // Heuristic: cheapest assignment of boxes to distinct goals, each box
  // costed by its own push-distance table. Admissible: the true solution
  // assigns each box to one goal, and no box can reach its goal in fewer
  // pushes than its table says.
  const heuristic = (boxes: number[]): number => {
    const m = boxes.length;
    if (m === 0) return 0;
    const used = new Uint8Array(room.goals.length);
    let best = INF;
    const rec = (i: number, sum: number): void => {
      if (sum >= best) return;
      if (i === m) { best = sum; return; }
      for (let g = 0; g < room.goals.length; g++) {
        if (used[g]) continue;
        const d = dist[g][boxes[i]];
        if (d === INF) continue;
        used[g] = 1;
        rec(i + 1, sum + d);
        used[g] = 0;
      }
    };
    rec(0, 0);
    return best;
  };

  // Flood fill from `start` over room cells, treating `boxSet` as walls.
  // Returns the reachable set and its smallest local index (the canonical
  // representative of the player's region: only the region matters for
  // which pushes are possible, not the exact cell the player stands on).
  const flood = (start: number, boxSet: Uint8Array): { reach: Uint8Array; rep: number } => {
    const reach = new Uint8Array(n);
    const stack = [start];
    reach[start] = 1;
    let rep = start;
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (c < rep) rep = c;
      for (let d = 0; d < 4; d++) {
        const t = nbr[c * 4 + d];
        if (t === -1 || reach[t] || boxSet[t]) continue;
        reach[t] = 1;
        stack.push(t);
      }
    }
    return { reach, rep };
  };

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const startSet = new Uint8Array(n);
  for (const b of startBoxes) startSet[b] = 1;
  if (startBoxes.some((b) => dead[b])) return null;
  // The player starts on the entry cell, outside the room proper.
  const startRep = flood(room.entry, startSet).rep;

  const keyOf = (boxes: number[], rep: number): string => boxes.join(',') + '|' + rep;
  const solved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);

  // Binary min-heap on (f, g, order) for a deterministic expansion order.
  type Node = { f: number; g: number; ord: number; boxes: number[]; rep: number };
  const heap: Node[] = [];
  let order = 0;
  const heapPush = (node: Node): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f < heap[i].f || (heap[p].f === heap[i].f && heap[p].ord <= heap[i].ord)) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = (): Node => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l].f < heap[m].f || (heap[l].f === heap[m].f && heap[l].ord < heap[m].ord))) m = l;
        if (r < heap.length && (heap[r].f < heap[m].f || (heap[r].f === heap[m].f && heap[r].ord < heap[m].ord))) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes);
  if (h0 === INF) return null;
  heapPush({ f: weight * h0, g: 0, ord: order++, boxes: startBoxes, rep: startRep });
  const bestG = new Map<string, number>();
  bestG.set(keyOf(startBoxes, startRep), 0);
  const parent = new Map<string, { p: string; box: number; dir: number }>();
  let expansions = 0;

  while (heap.length > 0) {
    const cur = heapPop();
    const curKey = keyOf(cur.boxes, cur.rep);
    if (bestG.get(curKey)! < cur.g) continue;
    if (++expansions > cap) return null;
    // Goal: every box on a goal, and the player can still walk out the door.
    if (solved(cur.boxes)) {
      const boxSet = new Uint8Array(n);
      for (const b of cur.boxes) boxSet[b] = 1;
      // The player stands on the cell the last box was pushed from; any
      // cell of its region works as the flood start, so use the rep.
      const { reach } = flood(cur.rep, boxSet);
      if (reach[room.door]) {
        const pushes: Push[] = [];
        let k = curKey;
        while (parent.has(k)) {
          const step = parent.get(k)!;
          pushes.push({ box: step.box, dir: step.dir });
          k = step.p;
        }
        pushes.reverse();
        return pushes;
      }
    }
    const boxSet = new Uint8Array(n);
    for (const b of cur.boxes) boxSet[b] = 1;
    const { reach } = flood(cur.rep, boxSet);
    for (let bi = 0; bi < cur.boxes.length; bi++) {
      const b = cur.boxes[bi];
      for (let d = 0; d < 4; d++) {
        const t = nbr[b * 4 + d];
        // A box is never pushed onto the entry cell (out of the room).
        if (t === -1 || t === room.entry || boxSet[t]) continue;
        const stand = nbr[b * 4 + (d ^ 1)];
        if (stand === -1 || !reach[stand]) continue;
        const next = [...cur.boxes];
        next[bi] = t;
        next.sort((a, z) => a - z);
        if (next.some((x) => dead[x])) continue;
        const nextSet = new Uint8Array(n);
        for (const x of next) nextSet[x] = 1;
        const nextRep = flood(b, nextSet).rep; // player ends on b
        const ng = cur.g + 1;
        const nk = keyOf(next, nextRep);
        if (bestG.has(nk) && bestG.get(nk)! <= ng) continue;
        const h = heuristic(next);
        if (h === INF) continue;
        bestG.set(nk, ng);
        parent.set(nk, { p: curKey, box: b, dir: d });
        heapPush({ f: ng + weight * h, g: ng, ord: order++, boxes: next, rep: nextRep });
      }
    }
  }
  return null;
}

// The replay needs the level width; it is attached to the room by solveLevel.
function replayPushes(
  room: Room,
  startBoxes: number[],
  pushes: Push[],
  playerLocal: number,
): { moves: string; player: number } {
  const n = room.cells.length;
  const w = (room as unknown as { levelW: number }).levelW;
  const nbr = new Int32Array(n * 4).fill(-1);
  for (let i = 0; i < n; i++) {
    const g = room.cells[i];
    const gx = g % w;
    const gy = (g / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = gx + DIRS[d].dx;
      const ny = gy + DIRS[d].dy;
      if (nx < 0 || ny < 0 || nx >= w) continue;
      const j = room.local.get(idx(nx, ny, w));
      if (j !== undefined) nbr[i * 4 + d] = j;
    }
  }
  const boxes = [...startBoxes];
  let player = playerLocal;
  let moves = '';
  const boxSetOf = (list: number[]): Uint8Array => {
    const s = new Uint8Array(n);
    for (const b of list) s[b] = 1;
    return s;
  };
  // BFS over local cells for the player's walk.
  const walkLocal = (from: number, to: number, blocked: Uint8Array): string | null => {
    if (from === to) return '';
    const prev = new Int32Array(n).fill(-1);
    const prevDir = new Int8Array(n).fill(-1);
    const queue = [from];
    prev[from] = from;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      for (let d = 0; d < 4; d++) {
        const t = nbr[cur * 4 + d];
        if (t === -1 || prev[t] !== -1 || blocked[t]) continue;
        prev[t] = cur;
        prevDir[t] = d;
        if (t === to) {
          let out = '';
          let c = t;
          while (c !== from) {
            out = DIRS[prevDir[c]].ch + out;
            c = prev[c];
          }
          return out;
        }
        queue.push(t);
      }
    }
    return null;
  };
  for (const push of pushes) {
    const b = push.box;
    const stand = nbr[b * 4 + (push.dir ^ 1)];
    const target = nbr[b * 4 + push.dir];
    const leg = walkLocal(player, stand, boxSetOf(boxes));
    if (leg === null) throw new Error('solver bug: push unreachable during replay');
    moves += leg + DIRS[push.dir].ch;
    boxes[boxes.indexOf(b)] = target;
    player = b;
  }
  return { moves, player };
}

// ---------------------------------------------------------- whole level ----

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = findRooms(level);
  const boxNow = new Set<number>(level.boxes);
  let player = level.player;
  let moves = '';

  // Fallback: a level with no rooms is solved as one room over the whole
  // floor (the generator never makes one, but the entry must still answer).
  const roomList: Room[] = rooms.length > 0 ? rooms : [wholeLevelRoom(level)];

  for (const room of roomList) {
    (room as unknown as { levelW: number }).levelW = level.w;
    const entryGlobal = room.cells[room.entry];
    // Walk the player to this room's entry cell (boxes are obstacles).
    const blocked = new Uint8Array(level.w * level.h);
    for (const b of boxNow) blocked[b] = 1;
    blocked[player] = 0;
    const walk = walkPath(level, player, entryGlobal, blocked);
    if (walk === null) return moves; // cannot reach the room: answer what we have
    moves += walk;
    player = entryGlobal;

    const startBoxes = [...room.boxes].sort((a, b) => a - b);
    let pushes: Push[] | null = null;
    for (const [weight, cap] of [[1, ASTAR_CAP], [2, WEIGHTED_CAP], [0, GREEDY_CAP]] as const) {
      pushes = solveRoom(room, level, weight, cap);
      if (pushes !== null) break;
    }
    if (pushes === null) return moves; // leave the room unsolved, keep the rest
    const replay = replayPushes(room, startBoxes, pushes, room.entry);
    moves += replay.moves;
    // Update the global box positions and the player's cell.
    for (const b of startBoxes) boxNow.delete(room.cells[b]);
    const endBoxes = [...startBoxes];
    for (const push of pushes) endBoxes[endBoxes.indexOf(push.box)] = replayBoxTarget(room, push);
    for (const b of endBoxes) boxNow.add(room.cells[b]);
    player = room.cells[replay.player];
  }
  return moves;
}

// The target cell of a push, in local indices.
function replayBoxTarget(room: Room, push: Push): number {
  const w = (room as unknown as { levelW: number }).levelW;
  const g = room.cells[push.box];
  const gx = g % w;
  const gy = (g / w) | 0;
  const nx = gx + DIRS[push.dir].dx;
  const ny = gy + DIRS[push.dir].dy;
  return room.local.get(idx(nx, ny, w))!;
}

// A "room" covering every floor cell of the level, used only when a level
// has no hallway rooms at all.
function wholeLevelRoom(level: Level): Room {
  const cells: number[] = [];
  for (let c = 0; c < level.w * level.h; c++) if (!level.wall[c]) cells.push(c);
  const local = new Map<number, number>();
  cells.forEach((c, i) => local.set(c, i));
  const boxes = level.boxes.map((c) => local.get(c)!).sort((a, b) => a - b);
  const goals: number[] = [];
  for (const c of cells) if (level.goal[c]) goals.push(local.get(c)!);
  const door = local.get(level.player)!;
  return { cells, local, boxes, goals, door, entry: door };
}

// ------------------------------------------------------------------ main ---

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
