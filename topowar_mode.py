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
    map_width: int = 40
    map_height: int = 40
    default_elevation: int = 4
    tick_rate: int = 20
    dig_seconds_per_tile: float = 5.0
    mg_build_seconds: float = 30.0
    match_time_seconds: int = 1200
    build_phase_seconds: int = 180
    # Soldiers move discretely: one tile per (1 / soldier_move_speed) seconds.
    soldier_move_speed: float = 1.0
    projectile_speed: float = 8.0
    grenade_range: float = 7.0
    grenade_windup_seconds: float = 3.0


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
    mode: str = "move"
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
    combat_halt: bool = False
    is_grenadier: bool = False
    is_officer: bool = False
    grenade_target: tuple[int, int] | None = None
    grenade_windup: float = 0.0
    sandbag_queue: list[int] = field(default_factory=list)


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
    required_staff: int = 1
    force_target: tuple[int, int] | None = None
    cooldown: float = 0.0
    burst_left: int = 0
    burst_shot_cooldown: float = 0.0  # inter-shot delay within a burst
    operators: set[int] = field(default_factory=set)
    facing: float = 0.0        # current barrel angle in degrees (0=east, 90=south, clockwise)
    arc_center: float = 0.0    # fixed center angle chosen when the MG is placed
    arc_half: float = 45.0     # degrees either side of arc_center within which MG can fire/swivel
    swivel_speed: float = 15.0 # degrees per second the barrel can rotate
    base_ground_is_trench: bool = False


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


@dataclass
class Mortar(Structure):
    hp: int = 10
    built: bool = False
    build_progress: float = 0.0
    build_required: float = 60.0
    target: tuple[int, int] | None = None
    ready: bool = False        # True when primed and crew can fire
    cooldown: float = 0.0      # shared reload / retarget cooldown (seconds remaining)
    operators: set[int] = field(default_factory=set)
    base_ground_is_trench: bool = False
    operable: bool = True


@dataclass
class Sandbag(Structure):
    hp: int = 3
    built: bool = False
    build_progress: float = 0.0
    build_required: float = 5.0
    base_ground_is_trench: bool = False


@dataclass
class BarbedWire(Structure):
    hp: int = 1
    built: bool = False
    build_progress: float = 0.0
    build_required: float = 2.0


@dataclass
class MortarShell:
    owner: int
    x: float
    y: float
    sx: float   # start x (for arc progress)
    sy: float   # start y
    target: tuple[int, int]
    speed: float = 5.0


@dataclass
class GrenadeShell:
    owner: int
    x: float
    y: float
    sx: float
    sy: float
    target: tuple[int, int]
    speed: float = 5.0


@dataclass
class FlareShell:
    owner: int
    x: float
    y: float
    sx: float
    sy: float
    target: tuple[int, int]
    speed: float = 2.5


@dataclass
class Explosion:
    x: float
    y: float
    age: float = 0.0
    duration: float = 0.8


@dataclass
class DeathMark:
    x: float
    y: float
    age: float = 0.0
    duration: float = 3.0


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

        direct = self._preferred_zigzag_path(start, goal, blocked=blocked, trench_only=trench_only)
        if direct:
            out = direct[:-1] if (stop_adjacent and len(direct) >= 2) else direct
            return out

        q = deque([start])
        prev: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
        while q:
            cx, cy = q.popleft()
            for nx, ny in self._ordered_neighbors((cx, cy), goal):
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

    def _ordered_neighbors(self, cur: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
        cx, cy = cur
        gx, gy = goal
        dx = gx - cx
        dy = gy - cy
        sx = 1 if dx > 0 else -1
        sy = 1 if dy > 0 else -1
        abs_dx = abs(dx)
        abs_dy = abs(dy)
        if abs_dx >= abs_dy:
            primary = [(cx + sx, cy), (cx, cy + sy), (cx, cy - sy), (cx - sx, cy)]
        else:
            primary = [(cx, cy + sy), (cx + sx, cy), (cx - sx, cy), (cx, cy - sy)]
        # Deduplicate while preserving order.
        out: list[tuple[int, int]] = []
        seen: set[tuple[int, int]] = set()
        for n in primary:
            if n not in seen:
                seen.add(n)
                out.append(n)
        return out

    def _preferred_zigzag_path(self, start: tuple[int, int], goal: tuple[int, int], blocked: set[tuple[int, int]], trench_only: bool) -> list[tuple[int, int]] | None:
        if start == goal:
            return [start]
        x, y = start
        gx, gy = goal
        dx = gx - x
        dy = gy - y
        sx = 1 if dx > 0 else -1
        sy = 1 if dy > 0 else -1
        rem_x = abs(dx)
        rem_y = abs(dy)
        path = [start]
        prefer_x = rem_x >= rem_y
        while rem_x > 0 or rem_y > 0:
            took_step = False
            if prefer_x and rem_x > 0:
                nx, ny = x + sx, y
                took_step = True
            elif (not prefer_x) and rem_y > 0:
                nx, ny = x, y + sy
                took_step = True
            elif rem_x > 0:
                nx, ny = x + sx, y
                took_step = True
            elif rem_y > 0:
                nx, ny = x, y + sy
                took_step = True
            if not took_step:
                break
            nt = (nx, ny)
            if (not self.grid.in_bounds(nt)) or (nt in blocked) or (trench_only and nt not in self.grid.trenches and nt != goal):
                return None
            path.append(nt)
            x, y = nx, ny
            rem_x = abs(gx - x)
            rem_y = abs(gy - y)
            prefer_x = not prefer_x
        if path[-1] != goal:
            return None
        return path


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
        self.mortars: dict[int, Mortar] = {}
        self.sandbags: dict[int, Sandbag] = {}
        self.barbed_wire: dict[int, BarbedWire] = {}
        self.mortar_shells: list[MortarShell] = []
        self.grenade_shells: list[GrenadeShell] = []
        self.flare_shells: list[FlareShell] = []
        self.flares_remaining: dict[int, int] = {0: 5, 1: 5}
        self.projectiles: list[Projectile] = []
        self.explosions: list[Explosion] = []
        self.death_marks: list[DeathMark] = []
        self.last_tick_monotonic = 0.0
        self.grenade_tiles: dict[int, set[tuple[int, int]]] = {0: set(), 1: set()}
        self._name_pool: list[str] = []
        self.next_recruit_time: dict[int, float] = {0: 180.0, 1: 180.0}
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
        for i in range(7):
            rx = x0 + i
            bx = x0 + i
            self._spawn_soldier(0, (rx, y_red), is_grenadier=(i < 2), is_officer=(i == 2))
            self._spawn_soldier(1, (bx, y_blue), is_grenadier=(i < 2), is_officer=(i == 2))

    def _spawn_soldier(self, owner: int, tile: tuple[int, int], is_grenadier: bool = False, is_officer: bool = False):
        sid = self.next_unit_id
        self.next_unit_id += 1
        name = self._name_pool.pop(0) if self._name_pool else f"Pvt.{sid}"
        self.soldiers[sid] = Soldier(sid, owner, float(tile[0]), float(tile[1]), name=name, is_grenadier=is_grenadier, is_officer=is_officer)

    def _spawn_recruit(self, owner: int):
        """Spawn a new soldier on the back row. Weighted toward the middle 10 columns."""
        back_y = self.map.height - 1 if owner == 0 else 0
        x0_mid = (self.map.width - 10) // 2
        roll = self.random.random()
        if roll < 0.05:
            base_x = self.random.randint(0, 9)
        elif roll < 0.10:
            base_x = self.random.randint(self.map.width - 10, self.map.width - 1)
        else:
            base_x = self.random.randint(x0_mid, x0_mid + 9)
        occ = set(self._occupied_tiles().keys())
        for delta in range(self.map.width):
            for sign in (0, 1, -1):
                cx = (base_x + sign * delta) % self.map.width
                tile = (cx, back_y)
                if tile not in occ and self.map.in_bounds(tile):
                    live_officers = sum(1 for s in self.soldiers.values() if s.owner == owner and s.hp > 0 and s.is_officer)
                    live_grenadiers = sum(1 for s in self.soldiers.values() if s.owner == owner and s.hp > 0 and s.is_grenadier)
                    is_officer = live_officers < 1
                    is_grenadier = not is_officer and live_grenadiers < 2
                    self._spawn_soldier(owner, tile, is_grenadier=is_grenadier, is_officer=is_officer)
                    return

    def _try_spawn_recruits(self):
        for owner in (0, 1):
            if self.time_elapsed >= self.next_recruit_time[owner]:
                self.next_recruit_time[owner] += 180.0
                self._spawn_recruit(owner)

    def _occupied_tiles(self) -> dict[tuple[int, int], int]:
        return {s.tile: sid for sid, s in self.soldiers.items() if s.hp > 0}

    def _mg_tile_set(self) -> set[tuple[int, int]]:
        """Tiles physically occupied by machine guns (treated as solid)."""
        return {mg.tile for mg in self.mgs.values() if mg.hp > 0}

    def _mortar_tile_set(self) -> set[tuple[int, int]]:
        return {m.tile for m in self.mortars.values() if m.hp > 0}

    def _sandbag_tile_set(self) -> set[tuple[int, int]]:
        return {sb.tile for sb in self.sandbags.values() if sb.hp > 0}

    def _wire_tile_set(self) -> set[tuple[int, int]]:
        """Built wire tiles that block soldier movement."""
        return {w.tile for w in self.barbed_wire.values() if w.hp > 0 and w.built}

    def _wire_structure_tile_set(self) -> set[tuple[int, int]]:
        """All wire tiles including under-construction (for placement checks)."""
        return {w.tile for w in self.barbed_wire.values() if w.hp > 0}

    def _structure_tile_set(self) -> set[tuple[int, int]]:
        return self._mg_tile_set() | self._mortar_tile_set() | self._sandbag_tile_set()

    def _crew_positions_for_mortar(self, mortar: "Mortar") -> list[tuple[int, int]]:
        """Adjacent tiles of the same ground type as the mortar, usable as crew spots."""
        mx, my = mortar.tile
        in_trench = mortar.tile in self.map.trenches
        return [
            (mx + dx, my + dy)
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            if not (dx == 0 and dy == 0)
            and self.map.in_bounds((mx + dx, my + dy))
            and ((mx + dx, my + dy) in self.map.trenches) == in_trench
        ]

    def _mortar_adjacent_ground_valid(self, mortar: "Mortar") -> bool:
        """Mortar is operable only when all 8 neighbors match mortar tile ground type."""
        mx, my = mortar.tile
        tile_in_trench = mortar.tile in self.map.trenches
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                adj = (mx + dx, my + dy)
                if not self.map.in_bounds(adj):
                    return False
                if (adj in self.map.trenches) != tile_in_trench:
                    return False
        return True

    def _enforce_structure_ground_integrity(self):
        """Destroy structures whose own tile ground type changed since placement."""
        for mg in self.mgs.values():
            if mg.hp <= 0:
                continue
            current = mg.tile in self.map.trenches
            if current != mg.base_ground_is_trench:
                mg.hp = 0
                mg.operators.clear()
        for mortar in self.mortars.values():
            if mortar.hp <= 0:
                continue
            current = mortar.tile in self.map.trenches
            if current != mortar.base_ground_is_trench:
                mortar.hp = 0
                mortar.operators.clear()

    def _ensure_runtime_compat(self):
        """Backfill fields when loading older saved Topowar states."""
        if not hasattr(self, "sandbags"):
            self.sandbags = {}
        if not hasattr(self, "barbed_wire"):
            self.barbed_wire = {}
        if not hasattr(self, "flare_shells"):
            self.flare_shells = []
        if not hasattr(self, "flares_remaining"):
            self.flares_remaining = {0: 5, 1: 5}
        for s in self.soldiers.values():
            if not hasattr(s, "is_officer"):
                s.is_officer = False
        if not hasattr(self.rules, "grenade_range"):
            self.rules.grenade_range = 7.0
        if not hasattr(self.rules, "grenade_windup_seconds"):
            self.rules.grenade_windup_seconds = 3.0
        for s in self.soldiers.values():
            if not hasattr(s, "grenade_target"):
                s.grenade_target = None
            if not hasattr(s, "grenade_windup"):
                s.grenade_windup = 0.0
        for mg in self.mgs.values():
            if not hasattr(mg, "arc_center"):
                mg.arc_center = getattr(mg, "facing", 0.0)
            if not hasattr(mg, "base_ground_is_trench"):
                mg.base_ground_is_trench = (mg.tile in self.map.trenches)
        for mortar in self.mortars.values():
            if not hasattr(mortar, "base_ground_is_trench"):
                mortar.base_ground_is_trench = (mortar.tile in self.map.trenches)
            if not hasattr(mortar, "operable"):
                mortar.operable = True

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

    @staticmethod
    def _angle_diff_deg(a: float, b: float) -> float:
        """Signed shortest rotation from a to b in degrees, result in [-180, 180]."""
        d = (b - a) % 360.0
        if d > 180.0:
            d -= 360.0
        return d

    def _is_angle_within_arc(self, angle: float, arc_center: float, arc_half: float) -> bool:
        return abs(self._angle_diff_deg(arc_center, angle)) <= arc_half

    def _clamp_angle_to_arc(self, angle: float, arc_center: float, arc_half: float) -> float:
        rel = self._angle_diff_deg(arc_center, angle)
        rel = max(-arc_half, min(arc_half, rel))
        return (arc_center + rel) % 360.0

    def _trench_component(self, start: tuple[int, int]) -> set[tuple[int, int]]:
        """4-connected flood fill over trench tiles starting from start."""
        if start not in self.map.trenches:
            return set()
        visited: set[tuple[int, int]] = {start}
        queue: deque[tuple[int, int]] = deque([start])
        while queue:
            cx, cy = queue.popleft()
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                nt = (nx, ny)
                if nt in visited or not self.map.in_bounds(nt) or nt not in self.map.trenches:
                    continue
                visited.add(nt)
                queue.append(nt)
        return visited

    def _friendly_trench_tiles(self, owner: int) -> list[tuple[int, int]]:
        mid = self.map.height // 2
        return [p for p in self.map.trenches if (owner == 0 and p[1] >= mid) or (owner == 1 and p[1] < mid)]

    def _on_owner_side(self, owner: int, tile: tuple[int, int]) -> bool:
        mid = self.map.height // 2
        return tile[1] >= mid if owner == 0 else tile[1] < mid

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

    def _has_sandbag_cover_between(self, a: tuple[int, int], b: tuple[int, int]) -> bool:
        """True if a built sandbag lies strictly between endpoints on Bresenham path."""
        x0, y0 = a
        x1, y1 = b
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        sx = 1 if x1 >= x0 else -1
        sy = 1 if y1 >= y0 else -1
        err = dx - dy
        cx, cy = x0, y0
        sandbags = self._sandbag_tile_set()
        while True:
            if (cx, cy) == (x1, y1):
                return False
            if (cx, cy) != a and (cx, cy) in sandbags:
                return True
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
        self._ensure_runtime_compat()
        t = action.get("type")
        if t == "tw_assign_dig":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner:
                raise ValueError("Invalid soldier.")
            plan = [tuple(map(int, c)) for c in action.get("plan", [])]
            if not plan:
                raise ValueError("No dig plan.")
            sandbag_tiles = self._sandbag_tile_set()
            for p in plan:
                if not self.map.in_bounds(p):
                    raise ValueError("Dig target out of bounds.")
                if p in self.map.trenches:
                    raise ValueError("Tile is already a trench.")
                if p in sandbag_tiles:
                    raise ValueError("Cannot dig under a sandbag.")
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
            if tile in self._structure_tile_set():
                raise ValueError("Only one equipment structure can occupy a tile.")
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
            for mortar in self.mortars.values():
                if mortar.hp > 0 and max(abs(mortar.tile[0] - tile[0]), abs(mortar.tile[1] - tile[1])) <= 1:
                    raise ValueError("MG cannot be placed adjacent to a mortar.")
            mid = self.next_structure_id
            self.next_structure_id += 1
            facing = float(action.get("facing", 0.0)) % 360.0
            mg = MachineGun(mid, owner, tile, build_required=self.rules.mg_build_seconds, facing=facing, arc_center=facing)
            self.mgs[mid] = mg
            build_positions = self._build_positions_for_mg(tile)
            if len(build_positions) < 1:
                del self.mgs[mid]
                raise ValueError("MG must have at least one adjacent trench tile for builders.")

            chosen_ids: list[int] = []
            for sid in action.get("unit_ids", []):
                sid = int(sid)
                if sid in chosen_ids:
                    continue
                s = self.soldiers.get(sid)
                if s and s.owner == owner and s.hp > 0:
                    chosen_ids.append(sid)
            if len(chosen_ids) != 1:
                del self.mgs[mid]
                raise ValueError("Select exactly one friendly soldier to build the MG.")

            occ = (set(self._occupied_tiles().keys()) - {self.soldiers[sid].tile for sid in chosen_ids}) | self._mg_tile_set()
            best_assignment: list[tuple[int, tuple[int, int], list[tuple[int, int]]]] | None = None
            for spots in itertools.permutations(build_positions, 1):
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
        if t == "tw_assign_build_mortar":
            tile = tuple(map(int, action.get("tile", [])))
            target_raw = action.get("target", [])
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid mortar tile.")
            if tile in self._structure_tile_set():
                raise ValueError("Only one equipment structure can occupy a tile.")
            for other in self.mortars.values():
                if other.hp > 0 and max(abs(other.tile[0] - tile[0]), abs(other.tile[1] - tile[1])) <= 1:
                    raise ValueError("Mortar cannot be placed adjacent to another mortar.")
            if len(target_raw) != 2:
                raise ValueError("Invalid target tile.")
            target = tuple(map(int, target_raw))
            if not self.map.in_bounds(target):
                raise ValueError("Target out of bounds.")
            # All 8 adjacent tiles must be same ground type as the mortar tile.
            tile_in_trench = tile in self.map.trenches
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    adj = (tile[0] + dx, tile[1] + dy)
                    if not self.map.in_bounds(adj):
                        raise ValueError("Mortar tile too close to map edge.")
                    if (adj in self.map.trenches) != tile_in_trench:
                        raise ValueError("All 8 adjacent tiles must match the mortar tile's ground type.")
            mid = self.next_structure_id
            self.next_structure_id += 1
            mortar = Mortar(mid, owner, tile, target=target, base_ground_is_trench=(tile in self.map.trenches))
            self.mortars[mid] = mortar
            crew_spots = self._crew_positions_for_mortar(mortar)
            if len(crew_spots) < 2:
                del self.mortars[mid]
                raise ValueError("Not enough valid crew positions adjacent to mortar.")
            chosen_ids: list[int] = []
            for sid in action.get("unit_ids", []):
                sid = int(sid)
                if sid in chosen_ids:
                    continue
                soldier = self.soldiers.get(sid)
                if soldier and soldier.owner == owner and soldier.hp > 0:
                    chosen_ids.append(sid)
            if len(chosen_ids) != 2:
                del self.mortars[mid]
                raise ValueError("Select exactly 2 soldiers to build the mortar.")
            occ = (set(self._occupied_tiles().keys()) - {self.soldiers[sid].tile for sid in chosen_ids}) | self._mg_tile_set() | self._mortar_tile_set()
            best_assignment = None
            for spots in itertools.permutations(crew_spots, 2):
                candidate: list[tuple[int, tuple[int, int], list[tuple[int, int]]]] = []
                total_len = 0
                valid = True
                for sid, spot in zip(chosen_ids, spots):
                    soldier = self.soldiers.get(sid)
                    if not soldier or soldier.owner != owner:
                        valid = False
                        break
                    path = self.path.find_path(soldier.tile, spot, trench_only=False, blocked=occ - {soldier.tile})
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
                del self.mortars[mid]
                raise ValueError("Selected soldiers cannot reach mortar build positions.")
            for sid, build_tile, path in best_assignment:
                s = self.soldiers[sid]
                s.current_task = {"type": "build_mortar", "mortar_id": mid, "build_tile": list(build_tile)}
                s.path = path
            return "Mortar construction started."
        if t == "tw_fire_mortar":
            if self.time_elapsed < self.rules.build_phase_seconds:
                raise ValueError("Cannot fire during build phase.")
            mid = int(action.get("mortar_id", -1))
            mortar = self.mortars.get(mid)
            if not mortar or mortar.owner != owner:
                raise ValueError("Mortar not found.")
            if not mortar.operable:
                raise ValueError("Mortar is inoperable: rebuild matching adjacent ground first.")
            if not mortar.built or not mortar.ready:
                raise ValueError("Mortar is not ready.")
            if not mortar.target:
                raise ValueError("No target set.")
            live_crew = [s for s in self.soldiers.values()
                         if s.hp > 0 and s.owner == owner
                         and 0 < math.dist(s.tile, mortar.tile) <= 1.5]
            if len(live_crew) < 2:
                raise ValueError("Need 2 crew members adjacent to fire.")
            self._fire_mortar(mortar)
            return "Mortar fired."
        if t == "tw_set_mortar_target":
            mid = int(action.get("mortar_id", -1))
            mortar = self.mortars.get(mid)
            if not mortar or mortar.owner != owner:
                raise ValueError("Mortar not found.")
            if not mortar.operable:
                raise ValueError("Mortar is inoperable: rebuild matching adjacent ground first.")
            target_raw = action.get("target", [])
            if len(target_raw) != 2:
                raise ValueError("Invalid target.")
            new_target = tuple(map(int, target_raw))
            if not self.map.in_bounds(new_target):
                raise ValueError("Target out of bounds.")
            mortar.target = new_target
            mortar.ready = False
            mortar.cooldown = 20.0
            return "Mortar retargeted (20 s cooldown)."
        if t == "tw_toggle_operate_mortar":
            mid = int(action.get("mortar_id", -1))
            mortar = self.mortars.get(mid)
            if not mortar or mortar.owner != owner or not mortar.built:
                raise ValueError("Mortar not operable.")
            if not mortar.operable:
                raise ValueError("Mortar is inoperable: rebuild matching adjacent ground first.")
            mortar.operators = {int(x) for x in action.get("unit_ids", [])}
            occ = set(self._occupied_tiles().keys()) | self._mg_tile_set() | self._mortar_tile_set()
            crew_spots = self._crew_positions_for_mortar(mortar)
            for uid in mortar.operators:
                s = self.soldiers.get(uid)
                if s and s.owner == owner and s.hp > 0:
                    s.current_task = {"type": "operate_mortar", "mortar_id": mortar.structure_id}
                    if crew_spots and s.tile not in crew_spots:
                        goal = min(crew_spots, key=lambda tp: math.dist(s.tile, tp))
                        s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=occ - {s.tile})
            return "Mortar crew updated."
        if t == "tw_assign_build_sandbag":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner or s.hp <= 0:
                raise ValueError("Invalid soldier.")
            tile = tuple(map(int, action.get("tile", [])))
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid sandbag tile.")
            if max(abs(tile[0] - s.tile[0]), abs(tile[1] - s.tile[1])) != 1:
                raise ValueError("Sandbag must be placed in a tile adjacent to the soldier.")
            if tile in self.map.trenches:
                raise ValueError("Sandbags can only be built on open ground.")
            if tile in self._structure_tile_set():
                raise ValueError("Tile already occupied by a structure.")
            mid = self.next_structure_id
            self.next_structure_id += 1
            sb = Sandbag(mid, owner, tile, build_required=5.0, base_ground_is_trench=False)
            self.sandbags[mid] = sb
            if s.current_task and s.current_task.get("type") == "build_sandbag":
                s.sandbag_queue.append(mid)
                return "Sandbag queued."
            s.current_task = {"type": "build_sandbag", "sandbag_id": mid}
            return "Sandbag construction started."
        if t == "tw_set_grenade_tile":
            tile = tuple(map(int, action.get("tile", [])))
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid grenade target tile.")
            targets = self.grenade_tiles.setdefault(owner, set())
            if tile in targets:
                targets.remove(tile)
                return "Grenade target removed."
            if len(targets) >= 8:
                raise ValueError("Maximum 8 grenade targets.")
            targets.add(tile)
            return "Grenade target added."
        if t == "tw_fire_flare":
            if self.flares_remaining.get(owner, 0) <= 0:
                raise ValueError("No flares remaining.")
            officer = next(
                (s for s in self.soldiers.values() if s.owner == owner and s.hp > 0 and s.is_officer),
                None,
            )
            if officer is None:
                raise ValueError("No living officer available to fire flares.")
            target = tuple(map(int, action.get("tile", [])))
            if len(target) != 2 or not self.map.in_bounds(target):
                raise ValueError("Invalid flare target.")
            src = (float(officer.tile[0]), float(officer.tile[1]))
            dist = math.dist(src, target)
            scatter_radius = 3.0 + max(0.0, math.floor(max(0.0, dist - 10.0) / 5.0))
            angle = self.random.uniform(0.0, 2.0 * math.pi)
            scatter = self.random.uniform(0.0, scatter_radius)
            lx = int(round(target[0] + math.cos(angle) * scatter))
            ly = int(round(target[1] + math.sin(angle) * scatter))
            lx = max(0, min(self.map.width - 1, lx))
            ly = max(0, min(self.map.height - 1, ly))
            self.flare_shells.append(FlareShell(owner, src[0], src[1], src[0], src[1], (lx, ly)))
            self.flares_remaining[owner] -= 1
            return "Flare fired."
        if t == "tw_assign_wire":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner or s.hp <= 0:
                raise ValueError("Invalid soldier.")
            if s.current_task and s.current_task.get("type") == "build_wire":
                in_progress = self.barbed_wire.get(s.current_task.get("wire_id"))
                if in_progress and in_progress.hp > 0 and not in_progress.built:
                    raise ValueError("Soldier must finish the current wire before starting another.")
            tile = tuple(map(int, action.get("tile", [])))
            if len(tile) != 2 or not self.map.in_bounds(tile):
                raise ValueError("Invalid wire tile.")
            if max(abs(tile[0] - s.tile[0]), abs(tile[1] - s.tile[1])) != 1:
                raise ValueError("Wire must be placed on a tile adjacent to the soldier.")
            if tile in self.map.trenches:
                raise ValueError("Cannot place wire in a trench.")
            occupied = self._structure_tile_set() | self._wire_structure_tile_set()
            if tile in occupied:
                raise ValueError("Tile already occupied.")
            wid = self.next_structure_id
            self.next_structure_id += 1
            self.barbed_wire[wid] = BarbedWire(wid, owner, tile)
            s.current_task = {"type": "build_wire", "wire_id": wid, "progress": 0.0}
            return "Wire placement started."
        if t == "tw_move_unit":
            sid = int(action.get("unit_id", -1))
            s = self.soldiers.get(sid)
            if not s or s.owner != owner or s.hp <= 0:
                raise ValueError("Invalid soldier.")
            target = tuple(map(int, action.get("tile", [])))
            if len(target) != 2 or not self.map.in_bounds(target):
                raise ValueError("Invalid move target.")
            occ = set(self._occupied_tiles().keys()) | self._mg_tile_set() | self._mortar_tile_set() | self._sandbag_tile_set() | self._wire_tile_set()
            s.current_task = {"type": "move", "goal": list(target)}
            s.combat_halt = False
            s.path = self.path.find_path(s.tile, target, trench_only=False, blocked=occ - {s.tile})
            return "Unit moving."
        if t == "tw_cancel_task":
            s = self.soldiers.get(int(action.get("unit_id", -1)))
            if not s or s.owner != owner:
                raise ValueError("Invalid soldier.")
            task = s.current_task or {}
            tt = task.get("type")
            if tt == "build_mg":
                mid = int(task.get("mg_id", -1))
                mg = self.mgs.get(mid)
                if mg and mg.hp > 0 and not mg.built:
                    del self.mgs[mid]
                    for u in self.soldiers.values():
                        if u.current_task and u.current_task.get("type") == "build_mg" and int(u.current_task.get("mg_id", -1)) == mid:
                            u.current_task = None
                            u.path = []
            elif tt == "build_mortar":
                mid = int(task.get("mortar_id", -1))
                mortar = self.mortars.get(mid)
                if mortar and mortar.hp > 0 and not mortar.built:
                    del self.mortars[mid]
                    for u in self.soldiers.values():
                        if u.current_task and u.current_task.get("type") == "build_mortar" and int(u.current_task.get("mortar_id", -1)) == mid:
                            u.current_task = None
                            u.path = []
            elif tt == "build_sandbag":
                active_sid = int(task.get("sandbag_id", -1))
                sb = self.sandbags.get(active_sid)
                if sb and sb.hp > 0 and not sb.built:
                    del self.sandbags[active_sid]
                for queued_id in s.sandbag_queue:
                    queued = self.sandbags.get(queued_id)
                    if queued and queued.hp > 0 and not queued.built:
                        del self.sandbags[queued_id]
                s.sandbag_queue.clear()
            elif tt == "build_wire":
                wid = int(task.get("wire_id", -1))
                w = self.barbed_wire.get(wid)
                if w and w.hp > 0 and not w.built:
                    del self.barbed_wire[wid]
            s.current_task = None
            s.path = []
            s.blocked = False
            s.blocked_for = 0.0
            s.move_cooldown = 0.0
            s.attack_target_id = None
            return "Task canceled."
        raise ValueError("Unknown Topowar action.")

    def _move_soldier(self, s: Soldier, dt: float):
        # Combat-halted soldiers hold position.
        if s.combat_halt or s.grenade_windup > 0:
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
        if self.time_elapsed < self.rules.build_phase_seconds and not self._on_owner_side(s.owner, target):
            s.path = []
            s.move_cooldown = 0.0
            return
        # Reject non-rectilinear / non-adjacent steps (defensive guard).
        if abs(target[0] - s.tile[0]) + abs(target[1] - s.tile[1]) != 1:
            s.path = []
            s.move_cooldown = 0.0
            return
        occ = self._occupied_tiles()
        structure_tiles = self._structure_tile_set() | self._wire_tile_set()
        if target in structure_tiles or (target in occ and occ[target] != s.unit_id):
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
        if self.time_elapsed < self.rules.build_phase_seconds:
            return
        for s in self.soldiers.values():
            if s.hp <= 0 or s.is_grenadier:
                continue

            # Halt to engage an open-ground enemy when crossing open ground.
            advancing = (
                s.current_task is not None
                and s.current_task.get("type") == "move"
                and s.tile not in self.map.trenches
            )
            if advancing:
                open_enemy_near = any(
                    s2.hp > 0 and s2.owner != s.owner
                    and self._soldier_visible_to(s2, s.owner)
                    and s2.tile not in self.map.trenches
                    and math.dist(s.tile, s2.tile) <= 5.0
                    for s2 in self.soldiers.values()
                )
                s.combat_halt = open_enemy_near
            else:
                s.combat_halt = False

            s.rifle_cooldown = max(0.0, s.rifle_cooldown - dt)
            if s.rifle_cooldown > 0:
                continue

            picked = self._nearest_enemy(s.owner, s.tile, visible_only=True)
            if not picked:
                continue
            typ, tid = picked
            target_tile = self.soldiers[tid].tile if typ == "soldier" else self.mgs[tid].tile
            d = math.dist(s.tile, target_tile)
            if d > 5.0:
                continue

            # Hit chance: 25% when moving through open ground toward a trench enemy;
            # 50% when stationary (halted or already in a trench).
            is_moving = advancing and not s.combat_halt
            target_in_trench = typ == "soldier" and target_tile in self.map.trenches
            chance = 0.25 if (is_moving and target_in_trench) else 0.5

            s.rifle_cooldown = 3.0
            if self.random.random() <= chance:
                self.projectiles.append(Projectile(s.owner, s.x, s.y, target_tile[0] - s.x, target_tile[1] - s.y, 5.0, "rifle"))

    def _update_tasks(self, dt: float):
        occ = self._occupied_tiles()
        blocked_keys = set(occ.keys()) | self._mg_tile_set() | self._mortar_tile_set() | self._sandbag_tile_set() | self._wire_tile_set()
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            task = s.current_task
            if not task:
                # No active task: stay put.
                continue
            if task["type"] == "move":
                goal = tuple(task["goal"])
                if s.tile == goal:
                    # Arrived — clear task; soldier idles in place (still fires at visible enemies)
                    s.current_task = None
                    s.path = []
                    continue
                if not s.path or s.path[-1] != goal:
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
            elif task["type"] == "build_mortar":
                mortar = self.mortars.get(task["mortar_id"])
                if not mortar or mortar.hp <= 0 or mortar.built:
                    s.current_task = None
                    continue
                build_tile = tuple(task.get("build_tile", s.tile))
                if s.tile != build_tile:
                    s.path = self.path.find_path(s.tile, build_tile, trench_only=False, blocked=blocked_keys - {s.tile})
            elif task["type"] == "operate_mortar":
                mortar = self.mortars.get(task["mortar_id"])
                if not mortar or mortar.hp <= 0 or not mortar.built:
                    s.current_task = None
                    continue
                crew_spots = self._crew_positions_for_mortar(mortar)
                if crew_spots and s.tile not in crew_spots:
                    goal = min(crew_spots, key=lambda t: math.dist(s.tile, t))
                    s.path = self.path.find_path(s.tile, goal, trench_only=False, blocked=blocked_keys - {s.tile})
            elif task["type"] == "build_sandbag":
                sb = self.sandbags.get(task["sandbag_id"])
                if not sb or sb.hp <= 0 or sb.built:
                    if s.sandbag_queue:
                        s.current_task = {"type": "build_sandbag", "sandbag_id": s.sandbag_queue.pop(0)}
                    else:
                        s.current_task = None
                    continue
                # Soldier stays in place and builds from current position.
                sb.build_progress += dt
                if sb.build_progress >= sb.build_required:
                    sb.built = True
                    if s.sandbag_queue:
                        s.current_task = {"type": "build_sandbag", "sandbag_id": s.sandbag_queue.pop(0)}
                    else:
                        s.current_task = None
            elif task["type"] == "build_wire":
                w = self.barbed_wire.get(task.get("wire_id"))
                if not w or w.hp <= 0 or w.built:
                    s.current_task = None
                    continue
                task["progress"] = task.get("progress", 0.0) + dt
                if task["progress"] >= w.build_required:
                    w.built = True
                    s.current_task = None

    def _update_mortar_construction(self, dt: float):
        """Advance all unfinished mortars when at least two adjacent friendly soldiers are present.

        This is intentionally independent from individual soldier tasks, so starting
        another mortar with the same crew does not cancel progress on existing mortar
        builds.
        """
        for mortar in self.mortars.values():
            if mortar.hp <= 0 or mortar.built:
                continue
            adjacent_crew = [
                s for s in self.soldiers.values()
                if s.hp > 0 and s.owner == mortar.owner and 0 < math.dist(s.tile, mortar.tile) <= 1.5
            ]
            if len(adjacent_crew) < 2:
                continue
            mortar.build_progress += dt
            if mortar.build_progress >= mortar.build_required:
                mortar.built = True
                mortar.ready = True

    def _update_mgs(self, dt: float):
        if self.time_elapsed < self.rules.build_phase_seconds:
            return
        for mg in self.mgs.values():
            if mg.hp <= 0 or not mg.built:
                continue
            mg.facing = self._clamp_angle_to_arc(mg.facing, mg.arc_center, mg.arc_half)
            mg.cooldown = max(0.0, mg.cooldown - dt)
            mg.burst_shot_cooldown = max(0.0, mg.burst_shot_cooldown - dt)
            # Crew must be adjacent (not on the MG tile itself).
            live_ops = [sv for sv in self.soldiers.values() if sv.hp > 0 and sv.owner == mg.owner and 0 < math.dist(sv.tile, mg.tile) <= 1.5]
            if len(live_ops) < 1:
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
                    if d > 20:
                        continue
                    target_angle = math.degrees(math.atan2(sv.tile[1] - mg.tile[1], sv.tile[0] - mg.tile[0])) % 360.0
                    if not self._is_angle_within_arc(target_angle, mg.arc_center, mg.arc_half):
                        continue
                    if nearest is None or d < nearest[0]:
                        nearest = (d, sv.tile)
                if nearest:
                    target = nearest[1]
            if target is None:
                continue
            # Swivel barrel toward target at swivel_speed deg/s.
            sx, sy = mg.tile
            target_angle = math.degrees(math.atan2(target[1] - sy, target[0] - sx)) % 360.0
            if not self._is_angle_within_arc(target_angle, mg.arc_center, mg.arc_half):
                continue
            diff = self._angle_diff_deg(mg.facing, target_angle)
            max_turn = mg.swivel_speed * dt
            if abs(diff) <= max_turn:
                mg.facing = target_angle % 360.0
            else:
                mg.facing = (mg.facing + math.copysign(max_turn, diff)) % 360.0
            mg.facing = self._clamp_angle_to_arc(mg.facing, mg.arc_center, mg.arc_half)
            # Start a new burst cycle when cooldown expires
            if mg.cooldown <= 0 and mg.burst_left <= 0:
                mg.burst_left = 3
                mg.burst_shot_cooldown = 0.0
                mg.cooldown = 3.0
            # Fire one shot per ~0.33 s within the burst
            if mg.burst_left > 0 and mg.burst_shot_cooldown <= 0:
                mg.burst_left -= 1
                mg.burst_shot_cooldown = 1.0 / 3.0
                spreadx = self.random.uniform(-0.3, 0.3)
                spready = self.random.uniform(-0.3, 0.3)
                self.projectiles.append(Projectile(mg.owner, float(sx), float(sy), target[0] - sx + spreadx, target[1] - sy + spready, 20.0, "mg", self.map.elevation_at(mg.tile)))

    def _register_kill(self, victim: "Soldier", killer_owner: int):
        if victim.hp <= 0:
            return
        victim.hp = 0
        self.kill_counts[killer_owner] += 1
        self.death_marks.append(DeathMark(victim.x, victim.y))
        if victim.is_grenadier and victim.grenade_target is not None and victim.grenade_windup > 0.0:
            # Grenadier dies mid-prep: dropped grenade detonates at current tile.
            # Mark dead/clear grenade state first to avoid recursive self-kill loops.
            victim.grenade_target = None
            victim.grenade_windup = 0.0
            self._grenade_impact(victim.tile, victim.owner)

    def _fire_mortar(self, mortar: "Mortar"):
        if not mortar.target or not mortar.ready:
            return
        dist = math.dist(mortar.tile, mortar.target)
        scatter_radius = 3.0 + max(0.0, math.floor(max(0.0, dist - 10.0) / 5.0))
        angle = self.random.uniform(0.0, 2.0 * math.pi)
        scatter = self.random.uniform(0.0, scatter_radius)
        lx = int(round(mortar.target[0] + math.cos(angle) * scatter))
        ly = int(round(mortar.target[1] + math.sin(angle) * scatter))
        lx = max(0, min(self.map.width - 1, lx))
        ly = max(0, min(self.map.height - 1, ly))
        self.mortar_shells.append(MortarShell(
            mortar.owner,
            float(mortar.tile[0]), float(mortar.tile[1]),
            float(mortar.tile[0]), float(mortar.tile[1]),
            (lx, ly),
        ))
        mortar.ready = False
        mortar.cooldown = 20.0

    def _mortar_impact(self, landing: tuple[int, int], owner: int):
        lx, ly = landing
        wire_by_tile = {w.tile: w for w in self.barbed_wire.values() if w.hp > 0}
        for tx, ty in [(lx, ly), (lx+1, ly), (lx-1, ly), (lx, ly+1), (lx, ly-1)]:
            w = wire_by_tile.get((tx, ty))
            if w:
                w.hp = 0
        direct_sandbag = next(
            (sb for sb in self.sandbags.values() if sb.hp > 0 and sb.built and sb.tile == landing), None
        )
        if direct_sandbag:
            # Sandbag absorbs the hit: damage it, suppress all terrain deformation.
            direct_sandbag.hp -= 1
            if direct_sandbag.hp <= 0:
                direct_sandbag.hp = 0
            self.explosions.append(Explosion(float(lx), float(ly)))
            return

        # Blast kill radius
        target_in_trench = landing in self.map.trenches
        kill_radius = 3.0
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            if math.dist(s.tile, landing) > kill_radius:
                continue
            s_in_trench = s.tile in self.map.trenches
            if target_in_trench:
                if s_in_trench:
                    if self._has_los_through_trenches(landing, s.tile):
                        self._register_kill(s, owner)
                else:
                    self._register_kill(s, owner)
            else:
                if not s_in_trench and not self._has_sandbag_cover_between(landing, s.tile):
                    self._register_kill(s, owner)

        # Terrain deformation: landing → trench; 4 ortho adjacent flip type.
        # If a sandbag occupies an adjacent tile it absorbs the flip (takes damage, ground unchanged).
        if landing not in self.map.trenches:
            self.map.trenches.add(landing)
        collapsing: set[tuple[int, int]] = set()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            adj = (lx + dx, ly + dy)
            if not self.map.in_bounds(adj):
                continue
            adj_sandbag = next(
                (sb for sb in self.sandbags.values() if sb.hp > 0 and sb.built and sb.tile == adj), None
            )
            if adj_sandbag:
                adj_sandbag.hp -= 1
                if adj_sandbag.hp <= 0:
                    adj_sandbag.hp = 0
                # Ground under sandbag is protected — skip terrain flip for this tile.
                continue
            if adj in self.map.trenches:
                collapsing.add(adj)
                self.map.trenches.discard(adj)
            else:
                self.map.trenches.add(adj)

        # Soldiers on a tile that just flipped trench→open are crushed.
        for s in self.soldiers.values():
            if s.hp > 0 and s.tile in collapsing:
                self._register_kill(s, owner)

        self._enforce_structure_ground_integrity()
        self.explosions.append(Explosion(float(lx), float(ly)))

    def _update_mortars(self, dt: float):
        for mortar in self.mortars.values():
            if mortar.hp <= 0 or not mortar.built:
                continue
            mortar.operable = self._mortar_adjacent_ground_valid(mortar)
            if not mortar.operable:
                mortar.ready = False
                continue
            mortar.cooldown = max(0.0, mortar.cooldown - dt)
            if mortar.cooldown <= 0.0 and not mortar.ready:
                mortar.ready = True

    def _update_mortar_shells(self, dt: float):
        remaining: list[MortarShell] = []
        for shell in self.mortar_shells:
            tx, ty = shell.target
            dx = tx - shell.x
            dy = ty - shell.y
            dist = math.hypot(dx, dy)
            step = shell.speed * dt
            if dist <= step:
                self._mortar_impact(shell.target, shell.owner)
                continue
            else:
                shell.x += dx / dist * step
                shell.y += dy / dist * step
            remaining.append(shell)
        self.mortar_shells = remaining

    def _grenade_impact(self, landing: tuple[int, int], owner: int):
        for w in self.barbed_wire.values():
            if w.hp > 0 and w.tile == landing:
                w.hp = 0
        target_in_trench = landing in self.map.trenches
        kill_radius = 2.0
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            if math.dist(s.tile, landing) > kill_radius:
                continue
            s_in_trench = s.tile in self.map.trenches
            if target_in_trench:
                if s_in_trench:
                    if self._has_los_through_trenches(landing, s.tile):
                        self._register_kill(s, owner)
                else:
                    self._register_kill(s, owner)
            else:
                if not s_in_trench and not self._has_sandbag_cover_between(landing, s.tile):
                    self._register_kill(s, owner)
        self.explosions.append(Explosion(float(landing[0]), float(landing[1])))

    def _update_grenade_shells(self, dt: float):
        remaining: list[GrenadeShell] = []
        for shell in self.grenade_shells:
            tx, ty = shell.target
            vx, vy = tx - shell.x, ty - shell.y
            dist = math.hypot(vx, vy)
            if dist <= 0.05:
                self._grenade_impact(shell.target, shell.owner)
                self.grenade_tiles[shell.owner].discard(shell.target)
                continue
            step = min(dist, shell.speed * dt)
            shell.x += vx / dist * step
            shell.y += vy / dist * step
            remaining.append(shell)
        self.grenade_shells = remaining

    def _update_grenadiers(self, dt: float):
        if self.time_elapsed < self.rules.build_phase_seconds:
            return
        for s in self.soldiers.values():
            if s.hp <= 0 or not s.is_grenadier:
                continue
            targets = [
                t for t in self.grenade_tiles.get(s.owner, set())
                if math.dist(s.tile, t) <= self.rules.grenade_range
            ]
            if not targets:
                s.grenade_target = None
                s.grenade_windup = 0.0
                continue
            target = min(targets, key=lambda t: math.dist(s.tile, t))
            if s.grenade_target != target:
                s.grenade_target = target
                s.grenade_windup = self.rules.grenade_windup_seconds
            else:
                s.grenade_windup = max(0.0, s.grenade_windup - dt)
            s.path = []
            if s.grenade_windup <= 0 and s.grenade_target:
                tgt = s.grenade_target
                self.grenade_shells.append(GrenadeShell(
                    s.owner,
                    float(s.tile[0]), float(s.tile[1]),
                    float(s.tile[0]), float(s.tile[1]),
                    tgt,
                ))
                s.grenade_target = None
                s.grenade_windup = 0.0

    def _illuminated_tiles(self) -> set[tuple[int, int]]:
        """Tiles currently lit by in-flight flares (for fog-of-war override)."""
        result: set[tuple[int, int]] = set()
        for fs in self.flare_shells:
            total = math.dist((fs.sx, fs.sy), (fs.target[0], fs.target[1]))
            if total < 0.001:
                continue
            progress = min(1.0, math.dist((fs.x, fs.y), (fs.sx, fs.sy)) / total)
            radius = round(2 + 2 * (1 - abs(2 * progress - 1)))
            cx, cy = int(round(fs.x)), int(round(fs.y))
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    if dx * dx + dy * dy <= radius * radius:
                        t = (cx + dx, cy + dy)
                        if self.map.in_bounds(t):
                            result.add(t)
        return result

    def _update_flare_shells(self, dt: float):
        remaining: list[FlareShell] = []
        for shell in self.flare_shells:
            tx, ty = shell.target
            vx, vy = tx - shell.x, ty - shell.y
            dist = math.hypot(vx, vy)
            if dist <= shell.speed * dt:
                continue  # arrived, disappear with no ground effect
            step = shell.speed * dt
            shell.x += vx / dist * step
            shell.y += vy / dist * step
            remaining.append(shell)
        self.flare_shells = remaining

    def _update_effects(self, dt: float):
        for e in self.explosions:
            e.age += dt
        self.explosions = [e for e in self.explosions if e.age < e.duration]
        for dm in self.death_marks:
            dm.age += dt
        self.death_marks = [dm for dm in self.death_marks if dm.age < dm.duration]

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
            if p.source == "mg":
                for sb in self.sandbags.values():
                    if sb.hp <= 0 or not sb.built:
                        continue
                    if math.dist((p.x, p.y), sb.tile) <= 0.45:
                        hit = True
                        break
            if hit:
                continue
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
                    self._register_kill(s, p.owner)
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
                                if op:
                                    self._register_kill(op, p.owner)
                        break
            if not hit and p.remaining > 0:
                remaining.append(p)
        self.projectiles = remaining

    def tick(self, dt: float):
        self._ensure_runtime_compat()
        if self.winner is not None:
            return
        self.time_elapsed += dt
        self._try_spawn_recruits()
        self._update_tasks(dt)
        self._enforce_structure_ground_integrity()
        for s in self.soldiers.values():
            if s.hp > 0:
                self._move_soldier(s, dt)
        self._update_mortar_construction(dt)
        self._rifle_combat(dt)
        self._update_mgs(dt)
        self._update_mortars(dt)
        self._update_mortar_shells(dt)
        self._update_grenadiers(dt)
        self._update_grenade_shells(dt)
        self._update_flare_shells(dt)
        self._update_projectiles(dt)
        self._update_effects(dt)
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
        self._ensure_runtime_compat()
        in_build_phase = self.time_elapsed < self.rules.build_phase_seconds
        illuminated = self._illuminated_tiles()
        soldiers = []
        for s in self.soldiers.values():
            if s.hp <= 0:
                continue
            if viewer is not None and s.owner != viewer:
                hidden = (
                    (in_build_phase and not self._on_owner_side(viewer, s.tile))
                    or not self._soldier_visible_to(s, viewer)
                )
                if hidden and s.tile not in illuminated:
                    continue
            task = None
            if s.current_task:
                task = {k: v for k, v in s.current_task.items() if k not in ("plan", "component")}
                if "plan" in s.current_task:
                    task["plan"] = [list(p) for p in s.current_task["plan"]]
            soldiers.append({
                "unit_id": s.unit_id,
                "owner": s.owner,
                "x": s.x,
                "y": s.y,
                "tile": list(s.tile),
                "mode": s.mode,
                "blocked": s.blocked,
                "task": task,
                "path": [list(p) for p in s.path] if (viewer is None or s.owner == viewer) else [],
                "sandbag_queue": list(s.sandbag_queue),
                "rifle_cooldown": s.rifle_cooldown,
                "name": s.name,
                "combat_halt": s.combat_halt,
                "is_grenadier": s.is_grenadier,
                "is_officer": s.is_officer,
            })
        mgs = []
        for mg in self.mgs.values():
            if mg.hp <= 0:
                continue
            if viewer is not None and mg.owner != viewer and in_build_phase and not self._on_owner_side(viewer, mg.tile) and mg.tile not in illuminated:
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
                "facing": mg.facing,
                "arc_center": mg.arc_center,
                "arc_half": mg.arc_half,
            })
        mortars_out = []
        for mortar in self.mortars.values():
            if mortar.hp <= 0:
                continue
            if viewer is not None and mortar.owner != viewer:
                lit = mortar.tile in illuminated
                if in_build_phase and not self._on_owner_side(viewer, mortar.tile) and not lit:
                    continue
                if mortar.tile in self.map.trenches and not lit:
                    continue
            mortars_out.append({
                "structure_id": mortar.structure_id,
                "owner": mortar.owner,
                "tile": list(mortar.tile),
                "hp": mortar.hp,
                "hp_max": 10,
                "built": mortar.built,
                "build_progress": mortar.build_progress,
                "build_required": mortar.build_required,
                "target": list(mortar.target) if mortar.target else None,
                "ready": mortar.ready,
                "operable": mortar.operable,
                "cooldown": mortar.cooldown,
                "operators": sorted(list(mortar.operators)),
            })
        sandbags_out = []
        for sb in self.sandbags.values():
            if sb.hp <= 0:
                continue
            if viewer is not None and sb.owner != viewer and in_build_phase and not self._on_owner_side(viewer, sb.tile) and sb.tile not in illuminated:
                continue
            sandbags_out.append({
                "structure_id": sb.structure_id,
                "owner": sb.owner,
                "tile": list(sb.tile),
                "hp": sb.hp,
                "hp_max": 3,
                "built": sb.built,
                "build_progress": sb.build_progress,
                "build_required": sb.build_required,
            })
        wire_out = []
        for w in self.barbed_wire.values():
            if w.hp <= 0:
                continue
            if viewer is not None and w.owner != viewer and in_build_phase and not self._on_owner_side(viewer, w.tile) and w.tile not in illuminated:
                continue
            wire_out.append({
                "structure_id": w.structure_id,
                "owner": w.owner,
                "tile": list(w.tile),
                "hp": w.hp,
                "built": w.built,
                "build_progress": w.build_progress,
                "build_required": w.build_required,
            })
        visible_trenches = self.map.trenches
        if in_build_phase and viewer is not None:
            visible_trenches = {t for t in self.map.trenches if self._on_owner_side(viewer, t) or t in illuminated}
        return {
            "rules": self.rules.__dict__.copy(),
            "build_phase_remaining": max(0.0, self.rules.build_phase_seconds - self.time_elapsed),
            "map": {
                "width": self.map.width,
                "height": self.map.height,
                "default_elevation": self.map.default_elevation,
                "trenches": [list(t) for t in sorted(visible_trenches)],
            },
            "soldiers": soldiers,
            "machine_guns": mgs,
            "mortars": mortars_out,
            "sandbags": sandbags_out,
            "barbed_wire": wire_out,
            "grenade_targets": [list(t) for t in sorted(self.grenade_tiles.get(viewer, set()))] if viewer is not None else [],
            "flare_shells": [{"x": fs.x, "y": fs.y, "sx": fs.sx, "sy": fs.sy, "target": list(fs.target), "owner": fs.owner} for fs in self.flare_shells],
            "flares_remaining": {"0": self.flares_remaining.get(0, 0), "1": self.flares_remaining.get(1, 0)},
            "mortar_shells": [{"x": ms.x, "y": ms.y, "sx": ms.sx, "sy": ms.sy, "target": list(ms.target), "owner": ms.owner} for ms in self.mortar_shells],
            "grenade_shells": [{"x": gs.x, "y": gs.y, "sx": gs.sx, "sy": gs.sy, "target": list(gs.target), "owner": gs.owner} for gs in self.grenade_shells],
            "projectiles": [{"x": p.x, "y": p.y, "owner": p.owner, "source": p.source} for p in self.projectiles],
            "explosions": [{"x": e.x, "y": e.y, "age": e.age, "duration": e.duration} for e in self.explosions],
            "death_marks": [{"x": dm.x, "y": dm.y, "age": dm.age, "duration": dm.duration} for dm in self.death_marks],
            "time_elapsed": self.time_elapsed,
            "time_remaining": max(0.0, self.rules.match_time_seconds - self.time_elapsed),
            "recruit_timers": {
                "0": max(0.0, self.next_recruit_time[0] - self.time_elapsed),
                "1": max(0.0, self.next_recruit_time[1] - self.time_elapsed),
            },
            "winner": self.winner,
            "win_reason": self.win_reason,
            "kill_counts": {"0": self.kill_counts[0], "1": self.kill_counts[1]},
        }
