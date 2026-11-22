# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ujang201/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ujang201/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.

Every generated level is a hallway plus 1–4 rooms, each holding 3–4 boxes and as many goals, and a box pushed out of a room through its door can never come back — so a level's push-optimal count is the sum of its rooms' push-optima. This solver exploits that structure: it solves each room on its own with A* over push states (admissible assignment heuristic + dead-square pruning), then stitches the rooms together with plain walking moves through the hallway. Walking costs no pushes, so the stitched solution is push-optimal for the level. The search budget is counted in node expansions, never wall-clock time, so two runs produce byte-identical answers.

## Usage

`main.ts` (Node 22) reads every instance under `/input/<id>/level.txt` (XSB format) and writes `/output/<id>/solution.txt` with the player's moves (`u`, `d`, `l`, `r`).

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice set

| instance | rooms | push-optimal |
|----------|-------|-------------|
| i001 | 1 | 13 |
| i002 | 1 | 16 |
| i003 | 2 | 29 |
| i004 | 3 | 47 |
| i005 | 4 | 60 |

The solver finds the push-optimal solution for every practice instance.

Built by an AI agent for [make.fun](https://make.fun/r/wfjv7kgb).
