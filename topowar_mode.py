from __future__ import annotations

from dataclasses import dataclass, field
from collections import deque
from typing import Any
import itertools
import math
import random

SOLDIER_NAMES = [
    "James", "Fred", "Jerry", "Henry", "Ferdinand", "Samuel", "Neb", "Moe",
    "Ned", "Art", "Red", "Leo", "Ted", "Ed", "Ray", "Roy", "Boe", "Ace",
    "Curt", "Herb", "Yan", "Rick", "Otto", "Percy", "Wes", "Joe", "Ham",
    "Ben", "Bert", "Zack", "Vin", "Ibble",
]


@dataclass
class RulesConfig:
    map_width: int = 30
    map_height: int = 30
    default_elevation: int = 4
    tick_rate: int = 20
    dig_seconds_per_tile: float = 5.0
    mg_build_seconds: float = 30.0
    match_time_seconds: int = 600
    # Soldiers move discretely: one tile per (1 / soldier_move_speed) seconds.
    soldier_move_speed: float = 1.0
    projectile_speed: float = 8.0


@dataclass
class GridMap:
    width: int
    height: int
    default_elevation: int
    trenches: set[tuple[int, int]] = field(default_factory=set)

    def in_bounds(self, t: tuple[int, int]) -> bool:
        x, y = t
        return 0 <= x < self.width and 0 <= y < self.height

    def elevation_at(self, t: tuple[int, int]) -> int:
        # Trench tiles are dug down — two units below open ground.
        if t in self.trenches:
            return self.default_elevation - 2
        return self.default_elevation


@dataclass
class Unit:
    unit_id: int
    owner: int
    # Soldiers occupy a single discrete tile at any moment; x and y are
    # the integer tile coordinates (kept as float for JSON compatibility).
    x: float
    y: float
    hp: int = 1

    @property
    def tile(self) -> tuple[int, int]:
        return int(self.x), int(self.y)


@dataclass
class Soldier(Unit):
    mode: str = "defend"
    sentry: bool = False
    blocked: bool = False
    blocked_for: float = 0.0
    current_task: dict[str, Any] | None = None
    path: list[tuple[int, int]] = field(default_factory=list)
    attack_target_id: int | None = None
    rifle_cooldown: float = 0.0
    # Seconds remaining until the soldier completes the current step in
    # `path`. While > 0 the soldier is still on its current tile.
    move_cooldown: float = 0.0
    name: str = ""


@dataclass
class Structure:
    structure_id: int
    owner: int
    tile: tuple[int, int]


@dataclass
class MachineGun(Structure):
    hp: int = 20
    built: bool = False
    build_progress: float = 0.0
    build_required: float = 30.0
    required_staff: int = 2
    force_target: tuple[int, int] | None = None
    cooldown: float = 0.0
    burst_left: int = 0
    burst_shot_cooldown: float = 0.0  # inter-shot delay within a burst
    operators: set[int] = field(default_factory=set)


@dataclass
class Projectile:
    owner: int
    x: float
    y: float
    dx: float
    dy: float
    remaining: float
    source: str
    origin_elevation: int = 0


class PathfindingService:
    def __init__(self, grid: GridMap):
        self.grid = grid

    def find_path(self, start: tuple[int, int], goal: tuple[int, int], trench_only: bool = False, blocked: set[tuple[int, int]] | None = None, stop_adjacent: bool = False) -> list[tuple[int, int]]:
        """BFS over the 4-connected grid.

        - `trench_only`: only step onto trench tiles (the goal itself is exempt).
        - `blocked`: tiles that cannot be stepped on (the goal is exempt so we
          can always reach it, even if currently occupied).
        - `stop_adjacent`: stop one tile short of the goal (used when the goal
          is an enemy unit we should not walk on top of).
        """
        if start == goal:
            return [start]
        blocked = (blocked or set()) - {goal}
        q = deque([start])
        prev: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
        while q:
            cx, cy = q.popleft()
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                nt = (nx, ny)
                if nt in prev or nt in blocked:
                    continue
                if not self.grid.in_bounds(nt):
                    continue
                if trench_only and nt not in self.grid.trenches and nt != goal:
                    continue
                prev[nt] = (cx, cy)
                if nt == goal:
                    q.clear()
                    break
                q.append(nt)
        if goal not in prev:
            return []
        out = []
        cur = goal
        while cur is not None:
            out.append(cur)
            cur = prev[cur]
        out.reverse()
        if stop_adjacent and len(out) >= 2:
            out = out[:-1]
        return out


class TopowarGameState:
    def __init__(self, rules: RulesConfig, seed: int = 1):
        self.rules = rules
        self.map = GridMap(rules.map_width, rules.map_height, rules.default_elevation)
        self.path = PathfindingService(self.map)
        self.random = random.Random(seed)
        self.time_elapsed = 0.0
        self.winner: int | None = None
        self.win_reason: str | None = None
        self.kill_counts = {0: 0, 1: 0}
        self.next_unit_id = 1
        self.next_structure_id = 1
        self.soldiers: dict[int, Soldier] = {}
        self.mgs: dict[int, MachineGun] = {}
        self.projectiles: list[Projectile] = []
        self.last_tick_monotonic = 0.0
        self._name_pool: list[str] = []
        self._setup()

    def _setup(self):
        names = list(SOLDIER_NAMES)
        self.random.shuffle(names)
        self._name_pool = names
        length = 10
        x0 = (self.map.width - length) // 2
        y_red = self.map.height - 5
        y_blue = 4
        for x in range(x0, x0 + length):
            self.map.trenches.add((x, y_red))
            self.map.trenches.add((x, y_blue))
        for i in range(5):
            rx = x0 + i * 2
            bx = x0 + i * 2
            self._spawn_soldier(0, (rx, y_red))
            self._spawn_soldier(1, (bx, y_blue))

    def _spawn_soldier(self, owner: int, tile: tuple[int, int]):
        sid = self.next_unit_id
        self.next_unit_id += 1
        name = self._name_pool.pop(0) if self._name_pool else f"Pvt.{sid}"
        self.soldiers[sid] = Soldier(sid, owner, float(tile[0]), float(tile[1]), name=name)

    def _occupied_tiles(self) -> dict[tuple[int, int], int]:
        return {s.tile: sid for sid, s in self.soldiers.items() if s.hp > 0}

    def _mg_tile_set(self) -> set[tuple[int, int]]:
        """Tiles physically occupied by machine guns (treated as solid)."""
        return {mg.tile for mg in self.mgs.values() if mg.hp > 0}

    def _crew_positions_for_mg(self, mg: "MachineGun") -> list[tuple[int, int]]:
        """Adjacent trench tiles a crew member can stand at to operate this MG."""
        mx, my = mg.tile
        neighbours = [
            (mx + dx, my + dy)
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            if not (dx == 0 and dy == 0)
        ]
        trench_adj = [t for t in neighbours if t in self.map.trenches and self.map.in_bounds(t)]
        # Fall back to any adjacent in-bounds tile if no trench is adjacent.
        return trench_adj if trench_adj else [t for t in neighbours if self.map.in_bounds(t)]

    def _build_positions_for_mg(self, mg_tile: tuple[int, int]) -> list[tuple[int, int]]:
        """Adjacent trench tiles where builders can stand to construct an MG."""
        mx, my = mg_tile
        neighbours = [
            (mx + dx, my + dy)
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            if not (dx == 0 and dy == 0)
        ]
        return [t for t in neighbours if self.map.in_bounds(t) and t in self.map.trenches]

    def _nearest_enemy(self, owner: int, from_tile: tuple[int, int], visible_only: bool = False) -> tuple[str, int] | None:
        best = None
        for sid, s in self.soldiers.items():
            if s.hp <= 0 or s.owner == owner:
                continue
            if visible_only and not self._soldier_visible_to(s, owner):
                continue
            d = math.dist(from_tile, s.tile)
            if best is None or d < best[0]:
                best = (d, "soldier", sid)
        if best is None:
            return None
        return best[1], best[2]

    def _attack_goal(self, s: "Soldier") -> tuple[int, int] | None:
        """Nearest enemy-occupied trench tile; falls back to nearest enemy anywhere."""
        best_d = float("inf")
        best_tile: tuple[int, int] | None = None
        for s2 in self.soldiers.values():
            if s2.hp <= 0 or s2.owner == s.owner:
                continue
            if s2.tile in self.map.trenches:
                d = math.dist(s.tile, s2.tile)
                if d < best_d:
                    best_d = d
                    best_tile = s2.tile
        if best_tile:
            return best_tile
        near = self._nearest_enemy(s.owner, s.tile)
        if near:
            typ, tid = near
            return self.soldiers[tid].tile if typ == "soldier" else self.mgs[tid].tile
        return None

    def _friendly_trench_tiles(self, owner: int) -> list[tuple[int, int]]:
        mid = self.map.height // 2
        return [p for p in self.map.trenches if (owner == 0 and p[1] >= mid) or (owner == 1 and p[1] < mid)]

    def _has_los_through_trenches(self, a: tuple[int, int], b: tuple[int, int]) -> bool:
        """Bresenham line-of-sight between two trench tiles.
        Blocked if any intermediate tile is not a trench (elevated open ground obstructs view)."""
        x0, y0 = a
        x1, y1 = b
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        sx = 1 if x1 >= x0 else -1
        sy = 1 if y1 >= y0 else -1
        err = dx - dy
        cx, cy = x0, y0
        while True:
            if (cx, cy) == (x1, y1):
                return True
            if (cx, cy) != a and (cx, cy) not in self.map.trenches:
                return False
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                cx += sx
            if e2 < dx:
                err += dx
                cy += sy

    def _soldier_visible_to(self, target: "Soldier", viewer: int) -> bool:
        """Enemy in a trench: visible if a friendly trench soldier has LOS, or a friendly
        soldier in the open is within rifle range (5 tiles) of the target."""
        if target.tile not in self.map.trenches:
            return True
        for s in self.soldiers.values():
            if s.hp <= 0 or s.owner != viewer:
                continue
            if s.tile in self.map.trenches:
                if self._has_los_through_trenches(s.tile, target.tile):
                    return True
            else:
                # Soldier in the open can spot nearby enemies within rifle range
                if math.dist(s.tile, target.tile) <= 5.0:
                    return True
        return False

    def command(self, owner: int, action: dict[str, Any]) -> str:
        t = action.get("type")
        if t == "tw_order_mode":
            mode = str(action.get("mode", "defend"))
            if mode not in {"defend", "attack", "sentry"}:
                raise ValueError("Unknown mode.")
            occ = set(self._occupied_tiles().keys())
            for sid in action.get("unit_ids", []):
                s = self.soldiers.get(int(sid))
                if not s or s.owner != owner or s.hp <= 0:
                    continue
                s.mode = mode
                s.sentry = mode == "sentry"
                s.current_task = None
                s.path = []
                if mode == "defend":
                    # Prefer retreating to nearest trench occupied by a friendly soldier
                    sid_int = int(sid)
                    friendly_occupied = [
                        s2.tile for s2 in self.soldiers.values()
                        if s2.hp > 0 and s2.owner == owner and s2.unit_id != sid_int
                        and s2.tile in self.map.trenches
                    ]
                    if friendly_occupied:
                        target = min(friendly_occupied, key=lambda p: math.dist(p, s.tile))
                    else:
                        trench_targets = self._friendly_trench_tiles(owner)
                        target = min(trench_targets, key=lambda p: math.dist(p, s.tile)) if trench_targets else None
                    if target:
                        s.path = self.path.find_path(s.tile, target, trench_only=False, blocked=occ - {s.tile})
                elif mode == "attack":
                    target_tile = action.get("target_tile")
                    if target_tile:
                        goal = tuple(map(int, target_tile))
                        if self.map.in_bounds(goal):
                            s.current_task = {"type": "advance", "goal": list(goal)}
                            s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=occ - {s.tile})
            return "Mode updated."
        if t == "tw_assign_dig":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner:
                raise ValueError("Invalid soldier.")
            plan = [tuple(map(int, c)) for c in action.get("plan", [])]
            if not plan:
                raise ValueError("No dig plan.")
            for p in plan:
                if not self.map.in_bounds(p):
                    raise ValueError("Dig target out of bounds.")
                if p in self.map.trenches:
                    raise ValueError("Tile is already a trench.")
            # First tile in the plan must be adjacent to an existing trench
            first = plan[0]
            adj4 = [(first[0]+dx, first[1]+dy) for dx, dy in ((1,0),(-1,0),(0,1),(0,-1))]
            if not any(a in self.map.trenches for a in adj4):
                raise ValueError("Dig must start adjacent to an existing trench.")
            # Cancel any other soldier already assigned to the same first tile
            for other in self.soldiers.values():
                if other.unit_id != sid and other.current_task and other.current_task.get("type") == "dig":
                    if tuple(other.current_task.get("target", (-1,-1))) == first:
                        other.current_task = None
                        other.path = []
            s.current_task = {"type": "dig", "plan": plan, "target": list(plan[0]), "progress": 0.0}
            # Path to the nearest trench tile adjacent to the first dig target (not onto the target itself)
            adj4_first = [(first[0]+dx, first[1]+dy) for dx, dy in ((1,0),(-1,0),(0,1),(0,-1))]
            dig_from = [t for t in adj4_first if t in self.map.trenches and self.map.in_bounds(t)]
            goal = min(dig_from, key=lambda t: math.dist(s.tile, t))
            s.path = self.path.find_path(s.tile, goal, trench_only=True, blocked=set(self._occupied_tiles().keys()) - {s.tile})
            return "Dig task assigned."
        if t == "tw_assign_build_mg":
            tile = tuple(map(int, action.get("tile", [])))
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid MG tile.")
            # MG must be placed on or adjacent to a friendly trench tile
            friendly = set(self._friendly_trench_tiles(owner))
            tile_and_adj = [tile] + [
                (tile[0] + dx, tile[1] + dy)
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
                if not (dx == 0 and dy == 0)
            ]
            if not any(n in friendly for n in tile_and_adj):
                raise ValueError("MG must be placed on or adjacent to a friendly trench tile.")
            mid = self.next_structure_id
            self.next_structure_id += 1
            mg = MachineGun(mid, owner, tile, build_required=self.rules.mg_build_seconds)
            self.mgs[mid] = mg
            build_positions = self._build_positions_for_mg(tile)
            if len(build_positions) < 2:
                del self.mgs[mid]
                raise ValueError("MG must have at least two adjacent trench tiles for builders.")

            chosen_ids: list[int] = []
            for sid in action.get("unit_ids", []):
                sid = int(sid)
                if sid in chosen_ids:
                    continue
                s = self.soldiers.get(sid)
                if s and s.owner == owner and s.hp > 0:
                    chosen_ids.append(sid)
            if len(chosen_ids) != 2:
                del self.mgs[mid]
                raise ValueError("Select exactly two friendly soldiers to build the MG.")

            occ = set(self._occupied_tiles().keys()) | self._mg_tile_set()
            best_assignment: list[tuple[int, tuple[int, int], list[tuple[int, int]]]] | None = None
            for spots in itertools.permutations(build_positions, 2):
                candidate: list[tuple[int, tuple[int, int], list[tuple[int, int]]]] = []
                total_len = 0
                valid = True
                for sid, spot in zip(chosen_ids, spots):
                    soldier = self.soldiers[sid]
                    path = self.path.find_path(soldier.tile, spot, trench_only=True, blocked=occ - {soldier.tile})
                    if not path:
                        valid = False
                        break
                    total_len += len(path)
                    candidate.append((sid, spot, path))
                if not valid:
                    continue
                if best_assignment is None or total_len < sum(len(p) for _, _, p in best_assignment):
                    best_assignment = candidate

            if best_assignment is None:
                del self.mgs[mid]
                raise ValueError("Selected soldiers cannot reach adjacent trench build positions.")

            for sid, build_tile, path in best_assignment:
                s = self.soldiers[sid]
                s.current_task = {"type": "build_mg", "mg_id": mid, "build_tile": list(build_tile)}
                s.path = path
            return "MG construction started."
        if t == "tw_toggle_operate_mg":
            mg = self.mgs.get(int(action.get("mg_id", -1)))
            if not mg or mg.owner != owner or not mg.built:
                raise ValueError("MG not operable.")
            mg.operators = {int(x) for x in action.get("unit_ids", [])}
            occ = set(self._occupied_tiles().keys()) | self._mg_tile_set()
            crew_spots = self._crew_positions_for_mg(mg)
            for uid in mg.operators:
                s = self.soldiers.get(uid)
                if s and s.owner == owner and s.hp > 0:
                    s.current_task = {"type": "operate_mg", "mg_id": mg.structure_id}
                    if crew_spots and s.tile not in crew_spots:
                        goal = min(crew_spots, key=lambda t: math.dist(s.tile, t))
                        s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=occ - {s.tile})
            return "MG operators updated."
        if t == "tw_force_fire":
            mg = self.mgs.get(int(action.get("mg_id", -1)))
            if not mg or mg.owner != owner:
                raise ValueError("MG not found.")
            target = action.get("tile")
            mg.force_target = tuple(map(int, target)) if target else None
            return "Force target set." if mg.force_target else "Force target cleared."
        if t == "tw_move_unit":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner or s.hp <= 0:
                raise ValueError("Invalid soldier.")
            target = tuple(map(int, action.get("tile", [])))
            if len(target) != 2 or not self.map.in_bounds(target):
                raise ValueError("Invalid move target.")
            if s.mode != "defend":
                raise ValueError("Only defending soldiers can be redirected from select mode.")
            if target not in self.map.trenches:
                raise ValueError("Move target must be a trench tile.")
            occ = set(self._occupied_tiles().keys()) | self._mg_tile_set()
            s.current_task = None
            s.path = self.path.find_path(s.tile, target, trench_only=False, blocked=occ - {s.tile})
            return "Unit rerouted."
        if t == "tw_cancel_task":
            s = self.soldiers.get(int(action.get("unit_id", -1)))
            if not s or s.owner != owner:
                raise ValueError("Invalid soldier.")
            s.current_task = None
            s.path = []
            s.blocked = False
            s.blocked_for = 0.0
            s.move_cooldown = 0.0
            s.attack_target_id = None
            return "Task canceled."
        raise ValueError("Unknown Topowar action.")

    def _move_soldier(self, s: Soldier, dt: float):
        # Sentry soldiers hold position. All others may walk while reloading.
        if s.sentry:
            s.move_cooldown = 0.0
            return
        # Drop any path step that points to the tile we're already on.
        while s.path and s.path[0] == s.tile:
            s.path.pop(0)
            s.move_cooldown = 0.0
        if not s.path:
            s.blocked = False
            s.move_cooldown = 0.0
            return
        target = s.path[0]
        # Reject non-rectilinear / non-adjacent steps (defensive guard).
        if abs(target[0] - s.tile[0]) + abs(target[1] - s.tile[1]) != 1:
            s.path = []
            s.move_cooldown = 0.0
            return
        occ = self._occupied_tiles()
        mg_tiles = self._mg_tile_set()
        if target in mg_tiles or (target in occ and occ[target] != s.unit_id):
            s.blocked = True
            s.blocked_for += dt
            s.move_cooldown = 0.0
            return
        s.blocked = False
        s.blocked_for = 0.0
        # One full tile-step takes (1 / soldier_move_speed) seconds. The
        # soldier remains visually on its current tile until the cooldown
        # reaches zero, then snaps to the next tile.
        if s.move_cooldown <= 0.0:
            s.move_cooldown = 1.0 / max(0.001, self.rules.soldier_move_speed)
        s.move_cooldown -= dt
        if s.move_cooldown <= 0.0:
            s.x, s.y = float(target[0]), float(target[1])
            s.path.pop(0)
            s.move_cooldown = 0.0

    def _rifle_combat(self, dt: float):
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            s.rifle_cooldown = max(0.0, s.rifle_cooldown - dt)
            if s.rifle_cooldown > 0:
                continue

            # Sentry mode: stick to current attack target if still alive, visible, and in range
            picked: tuple[str, int] | None = None
            if s.sentry and s.attack_target_id is not None:
                typ_hint = "soldier" if s.attack_target_id in self.soldiers else "mg"
                target_obj = self.soldiers.get(s.attack_target_id) or self.mgs.get(s.attack_target_id)
                visible = (not isinstance(target_obj, Soldier)) or self._soldier_visible_to(target_obj, s.owner)
                if target_obj and getattr(target_obj, "hp", 0) > 0 and math.dist(s.tile, target_obj.tile) <= 5.0 and visible:
                    picked = (typ_hint, s.attack_target_id)
                else:
                    s.attack_target_id = None

            if picked is None:
                t = self._nearest_enemy(s.owner, s.tile, visible_only=True)
                if not t:
                    continue
                picked = t
                if s.sentry:
                    s.attack_target_id = picked[1]

            typ, tid = picked
            target_tile = self.soldiers[tid].tile if typ == "soldier" else self.mgs[tid].tile
            d = math.dist(s.tile, target_tile)
            if d > 5.0:
                if s.sentry:
                    s.attack_target_id = None
                continue

            chance = 0.5
            if typ == "soldier":
                se = self.map.elevation_at(s.tile)
                te = self.map.elevation_at(target_tile)
                if te < se:
                    chance = 0.25

            s.rifle_cooldown = 3.0
            if self.random.random() <= chance:
                self.projectiles.append(Projectile(s.owner, s.x, s.y, target_tile[0] - s.x, target_tile[1] - s.y, 5.0, "rifle"))

    def _update_tasks(self, dt: float):
        occ = self._occupied_tiles()
        blocked_keys = set(occ.keys()) | self._mg_tile_set()
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            task = s.current_task
            if not task:
                if s.mode == "attack":
                    goal = self._attack_goal(s)
                    if goal:
                        s.current_task = {"type": "advance", "goal": list(goal)}
                        s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=blocked_keys - {s.tile})
                # defend + sentry: stay put, no automatic pathing
                continue
            if task["type"] == "advance":
                goal = tuple(task["goal"])
                if s.tile == goal:
                    s.current_task = None
                    s.path = []
                    if goal in self.map.trenches:
                        # Entered a trench — occupy and defend from here
                        s.mode = "defend"
                        s.sentry = False
                    else:
                        # Reached open-ground target — hold and fire
                        s.mode = "sentry"
                        s.sentry = True
                else:
                    need = (not s.path) or math.dist(s.path[-1], goal) > 1.5
                    if need:
                        s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=blocked_keys - {s.tile})
            elif task["type"] == "dig":
                tgt = tuple(task["target"])
                adj4_tgt = [(tgt[0]+dx, tgt[1]+dy) for dx, dy in ((1,0),(-1,0),(0,1),(0,-1))]
                in_adj_trench = s.tile in self.map.trenches and s.tile in set(adj4_tgt)
                if not in_adj_trench:
                    if not s.path:
                        # Path to nearest trench tile adjacent to the dig target
                        goals = [t for t in adj4_tgt if t in self.map.trenches and self.map.in_bounds(t)]
                        if goals:
                            goal = min(goals, key=lambda g: math.dist(s.tile, g))
                            s.path = self.path.find_path(s.tile, goal, trench_only=True, blocked=blocked_keys - {s.tile})
                        else:
                            s.current_task = None
                    continue
                task["progress"] = task.get("progress", 0.0) + dt
                if task["progress"] >= self.rules.dig_seconds_per_tile:
                    self.map.trenches.add(tgt)
                    plan = task["plan"]
                    if plan:
                        plan.pop(0)
                    if not plan:
                        s.current_task = None
                    else:
                        next_tgt = tuple(plan[0])
                        task["target"] = list(next_tgt)
                        task["progress"] = 0.0
                        s.path = []  # Re-path to adjacent trench of new target
                        # Validate next tile is still adjacent to trench
                        adj4_next = [(next_tgt[0]+dx, next_tgt[1]+dy) for dx, dy in ((1,0),(-1,0),(0,1),(0,-1))]
                        if not any(a in self.map.trenches for a in adj4_next):
                            s.current_task = None
            elif task["type"] == "build_mg":
                mg = self.mgs.get(task["mg_id"])
                if not mg or mg.hp <= 0 or mg.built:
                    s.current_task = None
                    continue
                build_tile = tuple(task.get("build_tile", s.tile))
                if s.tile != build_tile:
                    s.path = self.path.find_path(s.tile, build_tile, trench_only=True, blocked=blocked_keys - {s.tile})
                adj = [u for u in self.soldiers.values() if u.hp > 0 and u.owner == mg.owner and 0 < math.dist(u.tile, mg.tile) <= 1.5]
                if len(adj) >= 2:
                    mg.build_progress += dt
                    if mg.build_progress >= mg.build_required:
                        mg.built = True
            elif task["type"] == "operate_mg":
                mg = self.mgs.get(task["mg_id"])
                if not mg or mg.hp <= 0 or not mg.built:
                    s.current_task = None
                    continue
                crew_spots = self._crew_positions_for_mg(mg)
                if crew_spots and s.tile not in crew_spots:
                    goal = min(crew_spots, key=lambda t: math.dist(s.tile, t))
                    s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=blocked_keys - {s.tile})

    def _update_mgs(self, dt: float):
        for mg in self.mgs.values():
            if mg.hp <= 0 or not mg.built:
                continue
            mg.cooldown = max(0.0, mg.cooldown - dt)
            mg.burst_shot_cooldown = max(0.0, mg.burst_shot_cooldown - dt)
            # Crew must be adjacent (not on the MG tile itself).
            live_ops = [sv for sv in self.soldiers.values() if sv.hp > 0 and sv.owner == mg.owner and 0 < math.dist(sv.tile, mg.tile) <= 1.5]
            if len(live_ops) < 2:
                continue
            target = mg.force_target
            if target is None:
                nearest = None
                for sv in self.soldiers.values():
                    if sv.hp <= 0 or sv.owner == mg.owner:
                        continue
                    if not self._soldier_visible_to(sv, mg.owner):
                        continue
                    d = math.dist(sv.tile, mg.tile)
                    if d <= 20 and (nearest is None or d < nearest[0]):
                        nearest = (d, sv.tile)
                if nearest:
                    target = nearest[1]
            if target is None:
                continue
            # Start a new burst cycle when cooldown expires
            if mg.cooldown <= 0 and mg.burst_left <= 0:
                mg.burst_left = 3
                mg.burst_shot_cooldown = 0.0
                mg.cooldown = 3.0
            # Fire one shot per ~0.33 s within the burst
            if mg.burst_left > 0 and mg.burst_shot_cooldown <= 0:
                mg.burst_left -= 1
                mg.burst_shot_cooldown = 1.0 / 3.0
                sx, sy = mg.tile
                spreadx = self.random.uniform(-0.3, 0.3)
                spready = self.random.uniform(-0.3, 0.3)
                self.projectiles.append(Projectile(mg.owner, float(sx), float(sy), target[0] - sx + spreadx, target[1] - sy + spready, 20.0, "mg", self.map.elevation_at(mg.tile)))

    def _update_projectiles(self, dt: float):
        remaining: list[Projectile] = []
        for p in self.projectiles:
            norm = math.hypot(p.dx, p.dy)
            if norm <= 0:
                continue
            speed = self.rules.projectile_speed
            p.x += p.dx / norm * speed * dt
            p.y += p.dy / norm * speed * dt
            p.remaining -= speed * dt
            hit = False
            for s in self.soldiers.values():
                if s.hp <= 0 or s.owner == p.owner:
                    continue
                if math.dist((p.x, p.y), (s.x, s.y)) <= 0.35:
                    target_e = self.map.elevation_at(s.tile)
                    if target_e < p.origin_elevation:
                        # Lower-elevation targets are harder to hit: 25% chance.
                        # MG fire at trench soldiers is fully deflected (shoots over them).
                        if p.source == "mg":
                            continue
                        if self.random.random() > 0.25:
                            continue
                    s.hp = 0
                    self.kill_counts[p.owner] += 1
                    hit = True
                    break
            if not hit:
                for mg in self.mgs.values():
                    if mg.hp <= 0 or mg.owner == p.owner:
                        continue
                    if p.source != "mg":
                        continue
                    if math.dist((p.x, p.y), mg.tile) <= 0.45:
                        mg.hp -= 1
                        hit = True
                        if mg.hp <= 0:
                            for uid in list(mg.operators):
                                op = self.soldiers.get(uid)
                                if op and op.hp > 0:
                                    op.hp = 0
                                    self.kill_counts[p.owner] += 1
                        break
            if not hit and p.remaining > 0:
                remaining.append(p)
        self.projectiles = remaining

    def tick(self, dt: float):
        if self.winner is not None:
            return
        self.time_elapsed += dt
        self._update_tasks(dt)
        for s in self.soldiers.values():
            if s.hp > 0:
                self._move_soldier(s, dt)
        self._rifle_combat(dt)
        self._update_mgs(dt)
        self._update_projectiles(dt)
        alive0 = sum(1 for s in self.soldiers.values() if s.owner == 0 and s.hp > 0)
        alive1 = sum(1 for s in self.soldiers.values() if s.owner == 1 and s.hp > 0)
        if alive0 == 0 or alive1 == 0:
            self.winner = 0 if alive0 > alive1 else 1 if alive1 > alive0 else None
            self.win_reason = "Elimination." if self.winner is not None else "Mutual elimination."
        elif self.time_elapsed >= self.rules.match_time_seconds:
            if self.kill_counts[0] > self.kill_counts[1]:
                self.winner = 0
                self.win_reason = "Time. More kills."
            elif self.kill_counts[1] > self.kill_counts[0]:
                self.winner = 1
                self.win_reason = "Time. More kills."
            else:
                self.winner = -1
                self.win_reason = "Time. Tie."

    def advance_to_time(self, now_monotonic: float):
        if self.last_tick_monotonic <= 0:
            self.last_tick_monotonic = now_monotonic
            return
        dt_total = max(0.0, now_monotonic - self.last_tick_monotonic)
        step = 1.0 / max(1, self.rules.tick_rate)
        loops = 0
        while dt_total >= step and loops < 10_000:
            self.tick(step)
            dt_total -= step
            loops += 1
        self.last_tick_monotonic = now_monotonic - dt_total

    def serialize(self, viewer: int | None = None) -> dict[str, Any]:
        soldiers = []
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            # Filter out enemy soldiers that are hidden in trenches
            if viewer is not None and s.owner != viewer and not self._soldier_visible_to(s, viewer):
                continue
            task = None
            if s.current_task:
                task = {k: v for k, v in s.current_task.items() if k != "plan"}
                if "plan" in s.current_task:
                    task["plan"] = [list(p) for p in s.current_task["plan"]]
            soldiers.append({
                "unit_id": s.unit_id,
                "owner": s.owner,
                "x": s.x,
                "y": s.y,
                "tile": list(s.tile),
                "mode": s.mode,
                "sentry": s.sentry,
                "blocked": s.blocked,
                "task": task,
                "path": [list(p) for p in s.path],
                "rifle_cooldown": s.rifle_cooldown,
                "name": s.name,
            })
        mgs = []
        for mg in self.mgs.values():
            if mg.hp <= 0:
                continue
            mgs.append({
                "structure_id": mg.structure_id,
                "owner": mg.owner,
                "tile": list(mg.tile),
                "hp": mg.hp,
                "hp_max": 20,
                "built": mg.built,
                "build_progress": mg.build_progress,
                "build_required": mg.build_required,
                "operators": sorted(list(mg.operators)),
                "force_target": list(mg.force_target) if mg.force_target else None,
            })
        return {
            "rules": self.rules.__dict__.copy(),
            "map": {
                "width": self.map.width,
                "height": self.map.height,
                "default_elevation": self.map.default_elevation,
                "trenches": [list(t) for t in sorted(self.map.trenches)],
            },
            "soldiers": soldiers,
            "machine_guns": mgs,
            "projectiles": [{"x": p.x, "y": p.y, "owner": p.owner, "source": p.source} for p in self.projectiles],
            "time_elapsed": self.time_elapsed,
            "time_remaining": max(0.0, self.rules.match_time_seconds - self.time_elapsed),
            "winner": self.winner,
            "win_reason": self.win_reason,
            "kill_counts": {"0": self.kill_counts[0], "1": self.kill_counts[1]},
        }
