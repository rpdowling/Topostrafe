from __future__ import annotations

from dataclasses import dataclass, field
from collections import deque
from typing import Any
import math
import random


@dataclass
class RulesConfig:
    map_width: int = 30
    map_height: int = 30
    default_elevation: int = 4
    tick_rate: int = 20
    dig_seconds_per_tile: float = 5.0
    mg_build_seconds: float = 30.0
    match_time_seconds: int = 600
    soldier_move_speed: float = 2.0
    projectile_speed: float = 5.0


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
        return self.default_elevation


@dataclass
class Unit:
    unit_id: int
    owner: int
    x: float
    y: float
    hp: int = 1

    @property
    def tile(self) -> tuple[int, int]:
        return int(round(self.x)), int(round(self.y))


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


class PathfindingService:
    def __init__(self, grid: GridMap):
        self.grid = grid

    def find_path(self, start: tuple[int, int], goal: tuple[int, int], trench_only: bool = False, blocked: set[tuple[int, int]] | None = None) -> list[tuple[int, int]]:
        if start == goal:
            return [start]
        blocked = blocked or set()
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
        self._setup()

    def _setup(self):
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
        self.soldiers[sid] = Soldier(sid, owner, float(tile[0]), float(tile[1]))

    def _occupied_tiles(self) -> dict[tuple[int, int], int]:
        return {s.tile: sid for sid, s in self.soldiers.items() if s.hp > 0}

    def _nearest_enemy(self, owner: int, from_tile: tuple[int, int]) -> tuple[str, int] | None:
        best = None
        for sid, s in self.soldiers.items():
            if s.hp <= 0 or s.owner == owner:
                continue
            d = math.dist(from_tile, s.tile)
            if best is None or d < best[0]:
                best = (d, "soldier", sid)
        for mid, mg in self.mgs.items():
            if mg.owner == owner or mg.hp <= 0:
                continue
            d = math.dist(from_tile, mg.tile)
            if best is None or d < best[0]:
                best = (d, "mg", mid)
        if best is None:
            return None
        return best[1], best[2]

    def command(self, owner: int, action: dict[str, Any]) -> str:
        t = action.get("type")
        if t == "tw_order_mode":
            mode = str(action.get("mode", "defend"))
            for sid in action.get("unit_ids", []):
                s = self.soldiers.get(int(sid))
                if not s or s.owner != owner or s.hp <= 0:
                    continue
                s.mode = mode
                s.sentry = mode == "sentry"
                if mode == "defend":
                    trench_targets = [p for p in self.map.trenches if (owner == 0 and p[1] > self.map.height // 2) or (owner == 1 and p[1] < self.map.height // 2)]
                    if trench_targets:
                        target = min(trench_targets, key=lambda p: math.dist(p, s.tile))
                        s.path = self.path.find_path(s.tile, target, trench_only=False, blocked=set(self._occupied_tiles().keys()) - {s.tile})
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
            s.current_task = {"type": "dig", "plan": plan, "target": plan[0], "progress": 0.0}
            s.path = self.path.find_path(s.tile, plan[0], trench_only=True, blocked=set(self._occupied_tiles().keys()) - {s.tile})
            return "Dig task assigned."
        if t == "tw_assign_build_mg":
            tile = tuple(map(int, action.get("tile", [])))
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid MG tile.")
            mid = self.next_structure_id
            self.next_structure_id += 1
            mg = MachineGun(mid, owner, tile, build_required=self.rules.mg_build_seconds)
            self.mgs[mid] = mg
            for sid in action.get("unit_ids", []):
                s = self.soldiers.get(int(sid))
                if s and s.owner == owner:
                    s.current_task = {"type": "build_mg", "mg_id": mid}
            return "MG construction started."
        if t == "tw_toggle_operate_mg":
            mg = self.mgs.get(int(action.get("mg_id", -1)))
            if not mg or mg.owner != owner or not mg.built:
                raise ValueError("MG not operable.")
            mg.operators = {int(x) for x in action.get("unit_ids", [])}
            return "MG operators updated."
        if t == "tw_force_fire":
            mg = self.mgs.get(int(action.get("mg_id", -1)))
            if not mg or mg.owner != owner:
                raise ValueError("MG not found.")
            target = action.get("tile")
            mg.force_target = tuple(map(int, target)) if target else None
            return "Force target set." if mg.force_target else "Force target cleared."
        if t == "tw_cancel_task":
            s = self.soldiers.get(int(action.get("unit_id", -1)))
            if not s or s.owner != owner:
                raise ValueError("Invalid soldier.")
            s.current_task = None
            s.path = []
            s.blocked = False
            s.blocked_for = 0.0
            return "Task canceled."
        raise ValueError("Unknown Topowar action.")

    def _move_soldier(self, s: Soldier, dt: float):
        if s.rifle_cooldown > 0:
            return
        if not s.path:
            return
        target = s.path[0]
        if s.tile == target:
            s.path.pop(0)
            if not s.path:
                return
            target = s.path[0]
        occ = self._occupied_tiles()
        if target in occ and occ[target] != s.unit_id:
            s.blocked = True
            s.blocked_for += dt
            return
        s.blocked = False
        tx, ty = target
        dx, dy = tx - s.x, ty - s.y
        dist = math.hypot(dx, dy)
        step = self.rules.soldier_move_speed * dt
        if dist <= step:
            s.x, s.y = float(tx), float(ty)
        elif dist > 0:
            s.x += dx / dist * step
            s.y += dy / dist * step

    def _rifle_combat(self, dt: float):
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            s.rifle_cooldown = max(0.0, s.rifle_cooldown - dt)
            t = self._nearest_enemy(s.owner, s.tile)
            if not t:
                continue
            typ, tid = t
            target_tile = self.soldiers[tid].tile if typ == "soldier" else self.mgs[tid].tile
            d = math.dist(s.tile, target_tile)
            if d > 5.0 or s.rifle_cooldown > 0:
                continue
            chance = 0.5
            if typ == "soldier":
                se = self.map.elevation_at(s.tile)
                te = self.map.elevation_at(target_tile)
                if se - te == 1 and target_tile in self.map.trenches:
                    chance = 0.25
            s.rifle_cooldown = 3.0
            if self.random.random() <= chance:
                self.projectiles.append(Projectile(s.owner, s.x, s.y, target_tile[0] - s.x, target_tile[1] - s.y, 5.0, "rifle"))

    def _update_tasks(self, dt: float):
        occ = self._occupied_tiles()
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            task = s.current_task
            if not task:
                if s.mode == "attack":
                    near = self._nearest_enemy(s.owner, s.tile)
                    if near:
                        typ, tid = near
                        goal = self.soldiers[tid].tile if typ == "soldier" else self.mgs[tid].tile
                        s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=set(occ.keys()) - {s.tile})
                continue
            if task["type"] == "dig":
                tgt = tuple(task["target"])
                if s.tile != tgt:
                    if not s.path:
                        s.path = self.path.find_path(s.tile, tgt, trench_only=True, blocked=set(occ.keys()) - {s.tile})
                    continue
                task["progress"] += dt
                if task["progress"] >= self.rules.dig_seconds_per_tile:
                    self.map.trenches.add(tgt)
                    plan = task["plan"]
                    plan.pop(0)
                    if not plan:
                        s.current_task = None
                    else:
                        task["target"] = plan[0]
                        task["progress"] = 0.0
            elif task["type"] == "build_mg":
                mg = self.mgs.get(task["mg_id"])
                if not mg or mg.hp <= 0 or mg.built:
                    s.current_task = None
                    continue
                if math.dist(s.tile, mg.tile) > 1.5:
                    s.path = self.path.find_path(s.tile, mg.tile, trench_only=False, blocked=set(occ.keys()) - {s.tile})
                adj = [u for u in self.soldiers.values() if u.hp > 0 and u.owner == mg.owner and math.dist(u.tile, mg.tile) <= 1.5]
                if len(adj) >= 2:
                    mg.build_progress += dt
                    if mg.build_progress >= mg.build_required:
                        mg.built = True

    def _update_mgs(self, dt: float):
        for mg in self.mgs.values():
            if mg.hp <= 0 or not mg.built:
                continue
            mg.cooldown = max(0.0, mg.cooldown - dt)
            ops = [self.soldiers.get(uid) for uid in mg.operators]
            live_ops = [u for u in ops if u and u.hp > 0 and math.dist(u.tile, mg.tile) <= 1.5]
            if len(live_ops) < 2:
                continue
            target = mg.force_target
            if target is None:
                nearest = None
                for s in self.soldiers.values():
                    if s.hp <= 0 or s.owner == mg.owner:
                        continue
                    d = math.dist(s.tile, mg.tile)
                    if d <= 20 and (nearest is None or d < nearest[0]):
                        nearest = (d, s.tile)
                if nearest:
                    target = nearest[1]
            if target is None:
                continue
            if mg.cooldown <= 0 and mg.burst_left <= 0:
                mg.burst_left = 3
                mg.cooldown = 3.0
            if mg.burst_left > 0:
                mg.burst_left -= 1
                sx, sy = mg.tile
                spreadx = self.random.uniform(-0.25, 0.25)
                spready = self.random.uniform(-0.25, 0.25)
                self.projectiles.append(Projectile(mg.owner, sx, sy, target[0] - sx + spreadx, target[1] - sy + spready, 20.0, "mg"))

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
                if s.hp <= 0:
                    continue
                if math.dist((p.x, p.y), (s.x, s.y)) <= 0.35:
                    if p.source == "mg":
                        mg_e = self.map.elevation_at((int(round(p.x)), int(round(p.y))))
                        su_e = self.map.elevation_at(s.tile)
                        if s.tile in self.map.trenches and su_e < mg_e:
                            continue
                    s.hp = 0
                    self.kill_counts[p.owner] += 1
                    hit = True
                    break
            if not hit:
                for mg in self.mgs.values():
                    if mg.hp <= 0:
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

    def serialize(self) -> dict[str, Any]:
        soldiers = []
        for s in self.soldiers.values():
            if s.hp <= 0:
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
