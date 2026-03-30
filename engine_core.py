import copy
import json
import random
from collections import defaultdict, deque
from dataclasses import dataclass


PLAYER_NAMES = {0: "Player 1", 1: "Player 2"}

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

@dataclass
class GameSettings:
    map_width: int = 30
    map_height: int = 30
    cell_size: int = 50
    map_type: str = "River"
    path_count: int = 16
    max_link_distance: int = 15
    start_band: int = 1
    time_limit_enabled: bool = False
    time_bank_seconds: int = 600
    retake_rule: bool = True
    inherited_attack_rule: bool = False
    show_unattackable_range_targets: bool = False
    entrench_rule: bool = True
    fortify_rule: bool = True
    low_point_restrict: bool = True
    require_move_confirmation: bool = False

    bot_castle_survival: int = 65
    bot_castle_kill_threat: int = 220
    bot_disconnect_enemy: int = 260
    bot_avoid_disconnect: int = 85
    bot_redundancy: int = 95
    bot_high_ground: int = 260
    bot_mobility: int = 35
    bot_local_expansion: int = 12
    bot_forward_pressure: int = 180
    bot_castle_protect: int = 75

    def rule_summary_lines(self):
        return [
            f"Map type: {self.map_type}",
            f"Path count/turn: {self.path_count}",
            f"Max link distance: {self.max_link_distance}",
            f"Start band: {self.start_band}",
            f"Time limit: {'On' if self.time_limit_enabled else 'Off'}",
            f"Time bank/side: {self.time_bank_seconds}s",
            f"Retake lock: {'On' if self.retake_rule else 'Off'}",
            f"Shared attack privilege: {'On' if self.inherited_attack_rule else 'Off'}",
            f"Show unattackable range targets: {'On' if self.show_unattackable_range_targets else 'Off'}",
            f"Sap: {'On' if self.entrench_rule else 'Off'}",
            f"Fortify: {'On' if self.fortify_rule else 'Off'}",
            f"Low Point Restrict: {'On' if self.low_point_restrict else 'Off'}",
            f"Require move confirmation: {'On' if self.require_move_confirmation else 'Off'}",
            "Attack rule: must attack downhill",
            "unless target group is cut off",
            "from its castle",
            "If shared privilege is on, any",
            "alive node grants its attack",
            "height to all alive nodes",
            "Build rule: road/node may go",
            "equal, lower, or 1 level higher",
        ]

    def elevation_legend_items(self):
        return [
            (1, "highest"),
            (2, "high"),
            (3, "mid"),
            (4, "low"),
            (5, "lowest"),
        ]

    def bot_weights(self):
        return {
            "castle_survival": self.bot_castle_survival,
            "castle_kill_threat": self.bot_castle_kill_threat,
            "disconnect_enemy": self.bot_disconnect_enemy,
            "avoid_disconnect": self.bot_avoid_disconnect,
            "redundancy": self.bot_redundancy,
            "high_ground": self.bot_high_ground,
            "mobility": self.bot_mobility,
            "local_expansion": self.bot_local_expansion,
            "forward_pressure": self.bot_forward_pressure,
            "castle_protect": self.bot_castle_protect,
        }

@dataclass
class MapData:
    width: int
    height: int
    grid: list

    def copy(self):
        return MapData(self.width, self.height, [row[:] for row in self.grid])

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.width and 0 <= y < self.height

    def get(self, x: int, y: int) -> int:
        return self.grid[y][x]

    def set(self, x: int, y: int, value: int):
        self.grid[y][x] = clamp(value, 1, 5)

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"width": self.width, "height": self.height, "grid": self.grid}, f)

    @staticmethod
    def load(path: str):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return MapData(data["width"], data["height"], data["grid"])

class MapGenerator:
    RANDOMIZED_ADJACENCY_TYPES = {"Noise", "Ridges", "Three Mountains", "Mountains"}

    @staticmethod
    def generate(width: int, height: int, map_type: str) -> MapData:
        if map_type == "Ridges":
            grid = MapGenerator._generate_ridges(width, height)
        elif map_type == "Plains":
            grid = MapGenerator._generate_plains(width, height)
        elif map_type == "Three Mountains":
            grid = MapGenerator._generate_three_mountains(width, height)
        elif map_type == "Mountains":
            grid = MapGenerator._generate_mountains(width, height)
        else:
            grid = MapGenerator._generate_noise(width, height)
        MapGenerator._normalize_boundary_bands(grid)
        if map_type in MapGenerator.RANDOMIZED_ADJACENCY_TYPES:
            MapGenerator._enforce_adjacency(grid)
            MapGenerator._normalize_boundary_bands(grid)
        return MapData(width, height, grid)

    @staticmethod
    def normalize_existing(width: int, height: int, grid) -> MapData:
        fixed = [[clamp(int(cell), 1, 5) for cell in row[:width]] for row in grid[:height]]
        if len(fixed) != height or any(len(row) != width for row in fixed):
            raise ValueError("Map grid dimensions do not match width/height.")
        MapGenerator._normalize_boundary_bands(fixed)
        MapGenerator._enforce_adjacency(fixed)
        MapGenerator._normalize_boundary_bands(fixed)
        return MapData(width, height, fixed)

    @staticmethod
    def _generate_noise(width: int, height: int):
        grid = [[0] * width for _ in range(height)]
        grid[0][0] = random.randint(1, 5)
        for y in range(height):
            for x in range(width):
                if x == 0 and y == 0:
                    continue
                neigh = []
                if x > 0:
                    neigh.append(grid[y][x - 1])
                if y > 0:
                    neigh.append(grid[y - 1][x])
                base = round(sum(neigh) / len(neigh))
                drift = random.choice([-1, 0, 0, 0, 1])
                low = max(1, max(n - 1 for n in neigh))
                high = min(5, min(n + 1 for n in neigh))
                grid[y][x] = clamp(base + drift, low, high)
        for _ in range(6):
            MapGenerator._smooth_pass(grid, jitter=1)
        return grid

    @staticmethod
    def _generate_plains(width: int, height: int):
        center_x = width / 2
        center_y = height / 2
        grid = [[3] * width for _ in range(height)]
        for y in range(height):
            for x in range(width):
                dist = abs(x - center_x) / max(1, width) + abs(y - center_y) / max(1, height)
                v = 4 if dist < 0.35 else 4
                if random.random() < 0.08:
                    v += random.choice([-1, 1])
                grid[y][x] = clamp(v, 1, 5)
        for _ in range(5):
            MapGenerator._smooth_pass(grid, jitter=0)
        return grid

    @staticmethod
    def _generate_ridges(width: int, height: int):
        grid = [[3] * width for _ in range(height)]
        ridge_count = max(2, width // 30)
        ridge_x = [random.randint(0, width - 1) for _ in range(ridge_count)]
        for y in range(height):
            ridge_x = [clamp(x + random.choice([-1, 0, 1]), 0, width - 1) for x in ridge_x]
            for x in range(width):
                d = min(abs(x - rx) for rx in ridge_x)
                if d <= 1:
                    v = 1
                elif d <= 3:
                    v = 2
                elif d <= 6:
                    v = 3
                elif d <= 10:
                    v = 4
                else:
                    v = 5
                if random.random() < 0.06:
                    v += random.choice([-1, 1])
                grid[y][x] = clamp(v, 1, 5)
        for _ in range(5):
            MapGenerator._smooth_pass(grid, jitter=0)
        return grid

    @staticmethod
    def _mountain_grid_from_peaks(width: int, height: int, peaks, noise=0.06):
        score = [[0.0] * width for _ in range(height)]
        for y in range(height):
            for x in range(width):
                s = 0.0
                for px, py, sigma, amp in peaks:
                    dx = x - px
                    dy = y - py
                    s += amp * pow(2.718281828, -((dx * dx + dy * dy) / (2 * sigma * sigma)))
                s += random.uniform(-noise, noise)
                score[y][x] = s

        grid = [[4] * width for _ in range(height)]
        max_s = max(max(row) for row in score)
        for y in range(height):
            for x in range(width):
                s = score[y][x] / max_s if max_s > 0 else 0
                if s > 0.85:
                    v = 1
                elif s > 0.50:
                    v = 2
                elif s > 0.25:
                    v = 3
                elif s > 0.15:
                    v = 4
                else:
                    v = 5 if random.random() < 0.32 else 4
                grid[y][x] = v

        for _ in range(2):
            MapGenerator._smooth_pass(grid, jitter=0)

        for px, py, sigma, amp in sorted(peaks, key=lambda t: t[3], reverse=True)[:3]:
            bx = clamp(int(round(px)), 0, width - 1)
            by = clamp(int(round(py)), 0, height - 1)
            grid[by][bx] = 1
            for nx, ny in valid_neighbors4(bx, by, width, height):
                grid[ny][nx] = min(grid[ny][nx], 2)
        return grid

    @staticmethod
    def _generate_mountains(width: int, height: int):
        peaks = []
        cx = width * 0.5 + random.uniform(-width * 0.05, width * 0.05)
        cy = height * 0.5 + random.uniform(-height * 0.05, height * 0.05)
        peaks.append((cx, cy, min(width, height) * 0.11, 1.8))

        for _ in range(random.randint(2, 4)):
            px = width * 0.5 + random.uniform(-width * 0.30, width * 0.30)
            py = height * 0.5 + random.uniform(-height * 0.30, height * 0.30)
            sigma = min(width, height) * random.uniform(0.04, 0.09)
            amp = random.uniform(0.3, 0.95)
            peaks.append((px, py, sigma, amp))
        return MapGenerator._mountain_grid_from_peaks(width, height, peaks)

    @staticmethod
    def _generate_three_mountains(width: int, height: int):
        scale = min(width, height)
        cx = width * 0.5
        cy = height * 0.5
        peaks = [
            (cx - width * 0.16 + random.uniform(-width * 0.03, width * 0.03), cy - height * 0.05 + random.uniform(-height * 0.03, height * 0.03), scale * 0.095, 1.55),
            (cx + width * 0.16 + random.uniform(-width * 0.03, width * 0.03), cy - height * 0.03 + random.uniform(-height * 0.03, height * 0.03), scale * 0.085, 1.30),
            (cx + random.uniform(-width * 0.03, width * 0.03), cy + height * 0.14 + random.uniform(-height * 0.03, height * 0.03), scale * 0.075, 1.10),
        ]
        for _ in range(random.randint(3, 5)):
            px = width * 0.5 + random.uniform(-width * 0.25, width * 0.25)
            py = height * 0.5 + random.uniform(-height * 0.22, height * 0.22)
            sigma = scale * random.uniform(0.035, 0.07)
            amp = random.uniform(0.30, 0.75)
            peaks.append((px, py, sigma, amp))
        return MapGenerator._mountain_grid_from_peaks(width, height, peaks, noise=0.05)

    @staticmethod
    def _force_lowest_edges(grid):
        h = len(grid)
        w = len(grid[0])
        for x in range(w):
            grid[0][x] = 5
            grid[h - 1][x] = 5
        for y in range(h):
            grid[y][0] = 5
            grid[y][w - 1] = 5

    @staticmethod
    def _force_inner_band_green_or_higher(grid):
        h = len(grid)
        w = len(grid[0])
        if w < 3 or h < 3:
            return
        for x in range(1, w - 1):
            grid[1][x] = min(grid[1][x], 4)
            grid[h - 2][x] = min(grid[h - 2][x], 4)
        for y in range(1, h - 1):
            grid[y][1] = min(grid[y][1], 4)
            grid[y][w - 2] = min(grid[y][w - 2], 4)

    @staticmethod
    def _normalize_boundary_bands(grid):
        MapGenerator._force_lowest_edges(grid)
        MapGenerator._force_inner_band_green_or_higher(grid)

    @staticmethod
    def _smooth_pass(grid, jitter=0):
        h = len(grid)
        w = len(grid[0])
        old = [row[:] for row in grid]
        for y in range(h):
            for x in range(w):
                neigh = [old[y][x]]
                for nx, ny in valid_neighbors4(x, y, w, h):
                    neigh.append(old[ny][nx])
                avg = round(sum(neigh) / len(neigh))
                if jitter and random.random() < 0.2:
                    avg += random.choice([-1, 1])
                around = list(valid_neighbors4(x, y, w, h))
                low = max(1, max(old[ny][nx] - 1 for nx, ny in around))
                high = min(5, min(old[ny][nx] + 1 for nx, ny in around))
                grid[y][x] = clamp(avg, low, high)

    @staticmethod
    def _enforce_adjacency(grid):
        h = len(grid)
        w = len(grid[0])
        for _ in range(w * h * 2):
            changed = False
            MapGenerator._normalize_boundary_bands(grid)
            for y in range(h):
                for x in range(w):
                    if x == 0 or y == 0 or x == w - 1 or y == h - 1:
                        continue
                    neigh = [grid[ny][nx] for nx, ny in valid_neighbors4(x, y, w, h)]
                    low = max(1, max(n - 1 for n in neigh))
                    high = min(5, min(n + 1 for n in neigh))
                    nv = clamp(grid[y][x], low, high)
                    if nv != grid[y][x]:
                        grid[y][x] = nv
                        changed = True
            if not changed:
                MapGenerator._normalize_boundary_bands(grid)
                return

@dataclass
class Node:
    owner: int
    starter: bool = False

@dataclass
class Road:
    road_id: int
    owner: int
    path: list

    @property
    def length(self) -> int:
        return max(0, len(self.path) - 1)

    @property
    def cells(self):
        return set(self.path[1:-1])

@dataclass
class PlayerState:
    owner: int
    resigned: bool = False

class GameState:
    def __init__(self, settings: GameSettings, map_data: MapData):
        self.settings = settings
        self.map = map_data
        self.players = [PlayerState(0), PlayerState(1)]
        self.nodes = {}
        self.roads = {}
        self.road_lookup = defaultdict(set)
        self.current_owner = 0
        self.remaining_path = settings.path_count
        self.time_remaining = {0: float(settings.time_bank_seconds), 1: float(settings.time_bank_seconds)}
        self.starter_placed = [False, False]
        self.winner = None
        self.win_reason = ""
        self.next_road_id = 1
        self.retake_locks = {}

    def clone(self):
        return copy.deepcopy(self)

    def current_player(self) -> PlayerState:
        return self.players[self.current_owner]

    def other_owner(self) -> int:
        return 1 - self.current_owner

    def has_starter(self, owner: int) -> bool:
        return any(node.owner == owner and node.starter for node in self.nodes.values())

    def player_nodes(self, owner: int):
        return [pos for pos, node in self.nodes.items() if node.owner == owner]

    def player_roads(self, owner: int):
        return [road for road in self.roads.values() if road.owner == owner]

    def road_at(self, pos):
        ids = self.road_lookup.get(pos)
        if not ids:
            return None
        rid = next(iter(ids))
        return self.roads.get(rid)

    def castle_pos(self, owner: int):
        for pos, node in self.nodes.items():
            if node.owner == owner and node.starter:
                return pos
        return None

    def _owner_graph(self, owner: int):
        node_positions = {pos for pos, node in self.nodes.items() if node.owner == owner}
        adj = {pos: set() for pos in node_positions}
        for pos in node_positions:
            x, y = pos
            for nx, ny in valid_neighbors4(x, y, self.map.width, self.map.height):
                if (nx, ny) in node_positions:
                    adj[pos].add((nx, ny))
        for road in self.roads.values():
            if road.owner != owner:
                continue
            a, b = road.path[0], road.path[-1]
            if a in adj and b in adj:
                adj[a].add(b)
                adj[b].add(a)
        return adj

    def connected_to_castle(self, owner: int):
        castle = self.castle_pos(owner)
        if castle is None:
            return set()
        adj = self._owner_graph(owner)
        if castle not in adj:
            return set()
        seen = {castle}
        stack = [castle]
        while stack:
            cur = stack.pop()
            for nxt in adj[cur]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    def is_connected_to_castle(self, pos) -> bool:
        node = self.nodes.get(pos)
        if node is None:
            return False
        return pos in self.connected_to_castle(node.owner)

    def can_build_from(self, pos, owner: int | None = None) -> bool:
        node = self.nodes.get(pos)
        if node is None:
            return False
        if owner is not None and node.owner != owner:
            return False
        return pos in self.connected_to_castle(node.owner)

    def road_is_connected_to_castle(self, road: Road) -> bool:
        connected = self.connected_to_castle(road.owner)
        return road.path[0] in connected or road.path[-1] in connected

    def attack_privilege_elevation(self, owner: int) -> int:
        connected = self.connected_to_castle(owner)
        if not connected:
            return 5
        return min(self.map.get(*pos) for pos in connected)

    def attack_elevation_for_source(self, src) -> int:
        node = self.nodes.get(src)
        if node is None:
            return self.map.get(*src)
        if not self.settings.inherited_attack_rule:
            return self.map.get(*src)
        if src not in self.connected_to_castle(node.owner):
            return self.map.get(*src)
        return self.attack_privilege_elevation(node.owner)

    def can_attack_from(self, src, dst) -> bool:
        return self.attack_elevation_for_source(src) < self.map.get(*dst)

    def route_build_allowed(self, src, route: list) -> bool:
        src_elev = self.map.get(*src)
        if not self.settings.low_point_restrict:
            min_allowed = max(1, src_elev - 1)
            return all(self.map.get(x, y) >= min_allowed for x, y in route[1:])
        low_point = src_elev
        for x, y in route[1:]:
            elev = self.map.get(x, y)
            if elev < max(1, low_point - 1):
                return False
            if elev > low_point:
                low_point = elev
        return True

    @staticmethod
    def traversal_cost_for_elevation(elev: int) -> int:
        return {5: 2, 4: 1, 3: 2, 2: 2, 1: 3}.get(int(elev), 2)

    def traversal_cost_for_cell(self, pos) -> int:
        return self.traversal_cost_for_elevation(self.map.get(*pos))

    def route_traversal_cost(self, route: list) -> int:
        return sum(self.traversal_cost_for_cell(pos) for pos in route[1:])

    def max_single_link_cost(self) -> int:
        return max(0, int(self.settings.max_link_distance))

    def max_route_steps(self) -> int:
        return max(0, int(self.settings.max_link_distance))

    def can_change_cell_to(self, pos, new_val: int) -> bool:
        x, y = pos
        if not self.map.in_bounds(x, y):
            return False
        if x == 0 or y == 0 or x == self.map.width - 1 or y == self.map.height - 1:
            return False
        if not (1 <= new_val <= 5):
            return False
        return all(abs(new_val - self.map.get(nx, ny)) <= 1 for nx, ny in valid_neighbors4(x, y, self.map.width, self.map.height))

    def preview_entrench(self, src, target):
        if self.winner is not None:
            return False, "Game over."
        if not self.settings.entrench_rule:
            return False, "Sap is disabled."
        if src not in self.nodes or self.nodes[src].owner != self.current_owner:
            return False, "Select your own node first."
        if not self.can_build_from(src, self.current_owner):
            return False, "Cannot act from nodes disconnected from your castle."
        if not adjacent8(src, target):
            return False, "Sap must target an adjacent or diagonal square."
        if not self.map.in_bounds(*target):
            return False, "Out of bounds."
        cur = self.map.get(*target)
        if cur >= 5:
            return False, "That square is already at the lowest elevation."
        if any(self.map.get(nx, ny) not in (cur, cur + 1) for nx, ny in valid_neighbors4(target[0], target[1], self.map.width, self.map.height)):
            return False, "Sap requires all four adjacent squares to match the target square's current elevation."
        new_val = cur + 1
        if not self.can_change_cell_to(target, new_val):
            return False, "Sap would violate the adjacent elevation rule."
        return True, "Sap ready. Confirm or click the square again."

    def commit_entrench(self, src, target):
        ok, msg = self.preview_entrench(src, target)
        if not ok:
            return False, msg
        self.map.set(target[0], target[1], self.map.get(*target) + 1)
        self.check_winner()
        return True, "Sap complete."

    def fortify_eligible_road_cells(self, road: Road):
        if road is None:
            return []
        eligible = []
        for pos in road.path[1:-1]:
            cur = self.map.get(*pos)
            if cur <= 1:
                continue
            new_val = cur - 1
            if self.can_change_cell_to(pos, new_val):
                eligible.append(pos)
        return eligible

    def preview_fortify(self, pos):
        if self.winner is not None:
            return False, "Game over."
        if not self.settings.fortify_rule:
            return False, "Fortify is disabled."
        road = self.road_at(pos)
        if road is None:
            return False, "Select one of your road squares to fortify that path."
        if road.owner != self.current_owner:
            return False, "Select one of your own paths."
        if not self.road_is_connected_to_castle(road):
            return False, "Cannot fortify a path disconnected from your castle."
        eligible = self.fortify_eligible_road_cells(road)
        if not eligible:
            return False, "No road squares on that path can be raised without breaking the adjacent elevation rule."
        return True, f"Fortify ready on {len(eligible)} road square{'s' if len(eligible) != 1 else ''}."

    def commit_fortify(self, pos):
        ok, msg = self.preview_fortify(pos)
        if not ok:
            return False, msg
        road = self.road_at(pos)
        eligible = self.fortify_eligible_road_cells(road)
        for cell in eligible:
            self.map.set(cell[0], cell[1], self.map.get(*cell) - 1)
        self.check_winner()
        return True, f"Fortify complete on {len(eligible)} road square{'s' if len(eligible) != 1 else ''}."

    def practical_range_cells(self, src, radius: int, show_unattackable_targets: bool = True):
        import heapq

        node = self.nodes.get(src)
        if node is None or radius <= 0:
            return []

        src_elev = self.map.get(*src)
        start_low = src_elev
        reach = {}
        best = {(src, start_low): (0, 0)}
        pq = [(0, 0, src, start_low)]

        while pq:
            spent, steps, cur, low_point = heapq.heappop(pq)
            best_spent, best_steps = best.get((cur, low_point), (10**9, 10**9))
            if spent > best_spent or (spent == best_spent and steps > best_steps):
                continue
            if steps >= self.max_route_steps():
                continue

            for nxt in valid_neighbors4(cur[0], cur[1], self.map.width, self.map.height):
                elev = self.map.get(*nxt)
                if self.settings.low_point_restrict:
                    if elev < max(1, low_point - 1):
                        continue
                    next_low = max(low_point, elev)
                else:
                    if elev < max(1, src_elev - 1):
                        continue
                    next_low = start_low
                next_steps = steps + 1
                next_spent = spent + self.traversal_cost_for_cell(nxt)
                if next_spent > radius:
                    continue
                state_key = (nxt, next_low)
                prev = best.get(state_key)
                if prev is not None and (next_spent > prev[0] or (next_spent == prev[0] and next_steps >= prev[1])):
                    continue
                best[state_key] = (next_spent, next_steps)
                prev_reach = reach.get(nxt)
                if prev_reach is None or next_spent < prev_reach[0] or (next_spent == prev_reach[0] and next_steps < prev_reach[1]):
                    reach[nxt] = (next_spent, next_steps)

                other_node = self.nodes.get(nxt)
                if other_node is not None and nxt != src:
                    if other_node.owner == node.owner:
                        continue
                    protected = self.is_connected_to_castle(nxt)
                    if show_unattackable_targets or (not protected) or self.can_attack_from(src, nxt):
                        continue
                    reach.pop(nxt, None)
                    continue

                road = self.road_at(nxt)
                if road is not None:
                    if road.owner == node.owner:
                        continue
                    protected = self.road_is_connected_to_castle(road)
                    if show_unattackable_targets or (not protected) or self.can_attack_from(src, nxt):
                        continue
                    reach.pop(nxt, None)
                    continue

                heapq.heappush(pq, (next_spent, next_steps, nxt, next_low))
        return sorted(reach)

    def is_retake_blocked(self, pos, owner: int) -> bool:
        return self.settings.retake_rule and self.retake_locks.get(pos) == owner

    def preview_starter(self, x: int, y: int):
        if self.winner is not None:
            return False, "Game over."
        if self.has_starter(self.current_owner):
            return False, "Starter already placed."
        if not self.map.in_bounds(x, y):
            return False, "Out of bounds."
        if (x, y) in self.nodes or self.road_at((x, y)):
            return False, "Cell occupied."
        band = max(1, self.settings.start_band)
        if self.current_owner == 0 and x >= band:
            return False, "Player 1 starter must be on the left edge."
        if self.current_owner == 1 and x < self.map.width - band:
            return False, "Player 2 starter must be on the right edge."
        if (x, y) in {(0, 0), (0, self.map.height - 1), (self.map.width - 1, 0), (self.map.width - 1, self.map.height - 1)}:
            return False, "Castle cannot be placed in a corner."
        if self.map.get(x, y) != 5:
            return False, "Castle must be placed on the lowest elevation."
        return True, "Starter ready. Confirm to place."

    def commit_starter(self, x: int, y: int):
        ok, msg = self.preview_starter(x, y)
        if not ok:
            return False, msg
        self.nodes[(x, y)] = Node(self.current_owner, starter=True)
        self.starter_placed[self.current_owner] = True
        self.remaining_path = 0
        self.check_winner()
        return True, "Starter placed."

    def evaluate_routes(self, routes: list):
        if self.winner is not None:
            return False, "Game over.", None
        if not routes:
            return False, "No routes selected.", None
        if not self.has_starter(self.current_owner):
            return False, "Place your starter first.", None

        dest = routes[0][-1]
        total_cost = 0
        sources = []
        temp_occupied = set()
        connected_sources = self.connected_to_castle(self.current_owner)

        for route in routes:
            if len(route) < 2:
                return False, "Route too short.", None
            src = route[0]
            if src not in self.nodes or self.nodes[src].owner != self.current_owner:
                return False, "Every route must start on your own node.", None
            if src not in connected_sources:
                return False, "Cannot build from nodes disconnected from your castle.", None
            if route[-1] != dest:
                return False, "All routes this turn must end at the same node.", None
            if len(set(route)) != len(route):
                return False, "A route cannot revisit cells.", None
            if any(not self.map.in_bounds(x, y) for x, y in route):
                return False, "Out of bounds.", None
            if any(manhattan(route[i], route[i + 1]) != 1 for i in range(len(route) - 1)):
                return False, "Route must move orthogonally one cell at a time.", None
            if not self.route_build_allowed(src, route):
                return False, "Route and new node may only go to equal, lower, or one level higher terrain from the source.", None

            route_cost = self.route_traversal_cost(route)
            if route_cost > self.max_single_link_cost():
                return False, f"Max single link traversal cost is {self.max_single_link_cost()}.", None
            total_cost += route_cost
            sources.append(src)

            for pos in route[1:-1]:
                if pos in self.nodes:
                    return False, "Intermediate cells cannot cross nodes.", None
                if self.road_at(pos) is not None:
                    return False, "Intermediate cells cannot cross roads.", None
                if pos in temp_occupied:
                    return False, "Pending routes cannot overlap except at the destination.", None
                temp_occupied.add(pos)

        if len(set(sources)) != len(sources):
            return False, "Use each source node at most once this turn.", None
        if total_cost > self.remaining_path:
            return False, "Not enough traversal cost remaining this turn.", None

        dest_node = self.nodes.get(dest)
        dest_road = self.road_at(dest)
        mode = "build"
        target_road = None

        if dest_node is None and dest_road is None:
            mode = "build"
        elif dest_node and dest_node.owner == self.current_owner:
            mode = "connect_existing"
        elif dest_node and dest_node.owner != self.current_owner:
            if self.is_retake_blocked(dest, self.current_owner):
                return False, "Retake blocked on that node this turn.", None
            protected = self.is_connected_to_castle(dest)
            if protected and not any(self.can_attack_from(src, dest) for src in sources):
                return False, "You must attack from a node at a higher elevation unless that group is disconnected from its castle.", None
            mode = "attack_node"
        elif dest_road and dest_road.owner != self.current_owner:
            protected = self.road_is_connected_to_castle(dest_road)
            if protected and not any(self.can_attack_from(src, dest) for src in sources):
                return False, "You must attack that road section from a higher elevation unless that group is disconnected from its castle.", None
            mode = "attack_road"
            target_road = dest_road
        elif dest_road and dest_road.owner == self.current_owner:
            mode = "road_node"
            target_road = dest_road
        else:
            return False, "Illegal destination.", None

        summary = {
            "dest": dest,
            "dest_node": dest_node,
            "dest_road": dest_road,
            "target_road": target_road,
            "total_cost": total_cost,
            "mode": mode,
            "routes": [route[:] for route in routes],
        }
        return True, "Ready. Confirm to commit.", summary

    def commit_routes(self, routes: list):
        ok, msg, summary = self.evaluate_routes(routes)
        if not ok:
            return False, msg

        dest = summary["dest"]
        mode = summary["mode"]
        target_road = summary["target_road"]

        if mode == "attack_node":
            prior_owner = self.nodes[dest].owner if dest in self.nodes else None
            self._remove_node(dest)
            if self.settings.retake_rule and prior_owner is not None and self.winner is None:
                self.retake_locks[dest] = prior_owner
        elif mode == "attack_road" and target_road:
            self._remove_road(target_road.road_id)

        if mode in {"build", "attack_node", "attack_road", "road_node"}:
            self.nodes[dest] = Node(self.current_owner, starter=False)

        if mode == "road_node" and target_road:
            self._split_road_with_node(target_road, dest)

        for route in summary["routes"]:
            if len(route) > 2:
                self._create_road(route, self.current_owner)

        self.remaining_path -= summary["total_cost"]
        self._cull_isolated(0)
        self._cull_isolated(1)
        self.check_winner()
        return True, "Move placed."

    def _create_road(self, path: list, owner: int):
        if len(path) <= 2:
            return
        road = Road(self.next_road_id, owner, path[:])
        self.next_road_id += 1
        self.roads[road.road_id] = road
        for pos in road.cells:
            self.road_lookup[pos].add(road.road_id)

    def _split_road_with_node(self, road: Road, pos):
        if pos not in road.path[1:-1]:
            return
        idx = road.path.index(pos)
        left = road.path[: idx + 1]
        right = road.path[idx:]
        owner = road.owner
        self._remove_road(road.road_id)
        if len(left) > 2:
            self._create_road(left, owner)
        if len(right) > 2:
            self._create_road(right, owner)

    def _remove_road(self, road_id: int):
        road = self.roads.pop(road_id, None)
        if road is None:
            return
        for pos in road.cells:
            if road_id in self.road_lookup[pos]:
                self.road_lookup[pos].remove(road_id)
                if not self.road_lookup[pos]:
                    self.road_lookup.pop(pos, None)

    def _remove_node(self, pos):
        node = self.nodes.pop(pos, None)
        if node is None:
            return
        attached = [road_id for road_id, road in self.roads.items() if road.path[0] == pos or road.path[-1] == pos]
        for rid in attached:
            self._remove_road(rid)
        if node.starter and self.winner is None:
            self.winner = 1 - node.owner
            self.win_reason = f"{PLAYER_NAMES[node.owner]}'s castle was destroyed."

    def node_degree(self, pos) -> int:
        node = self.nodes.get(pos)
        if node is None:
            return 0
        owner = node.owner
        x, y = pos
        deg = 0
        for nx, ny in valid_neighbors4(x, y, self.map.width, self.map.height):
            other = self.nodes.get((nx, ny))
            if other and other.owner == owner:
                deg += 1
        for road in self.roads.values():
            if road.owner == owner and (road.path[0] == pos or road.path[-1] == pos):
                deg += 1
        return deg

    def _cull_isolated(self, owner: int):
        while True:
            remove = []
            for pos, node in list(self.nodes.items()):
                if node.owner != owner or node.starter:
                    continue
                if self.node_degree(pos) == 0:
                    remove.append(pos)
            if not remove:
                return
            for pos in remove:
                self._remove_node(pos)

    def end_turn(self):
        if self.winner is not None:
            return False, "Game over."
        old_owner = self.current_owner
        self.current_owner = self.other_owner()
        self.remaining_path = self.settings.path_count
        self._expire_retake_locks(old_owner)
        self._cull_isolated(0)
        self._cull_isolated(1)
        self.check_winner()
        return True, f"{PLAYER_NAMES[self.current_owner]}'s turn."

    def _expire_retake_locks(self, owner: int):
        if not self.retake_locks:
            return
        self.retake_locks = {pos: blocked for pos, blocked in self.retake_locks.items() if blocked != owner}

    def resign(self):
        if self.winner is not None:
            return
        self.players[self.current_owner].resigned = True
        self.winner = self.other_owner()
        self.win_reason = f"{PLAYER_NAMES[self.current_owner]} resigned."

    def check_winner(self):
        if self.winner is not None:
            return self.winner
        if self.players[0].resigned and not self.players[1].resigned:
            self.winner = 1
            self.win_reason = "Player 1 resigned."
            return self.winner
        if self.players[1].resigned and not self.players[0].resigned:
            self.winner = 0
            self.win_reason = "Player 2 resigned."
            return self.winner
        for owner in (0, 1):
            if self.starter_placed[owner] and not self.has_starter(owner):
                self.winner = 1 - owner
                self.win_reason = f"{PLAYER_NAMES[owner]}'s castle was destroyed."
                return self.winner
        if not all(self.starter_placed):
            return None
        alive = [bool(self.player_nodes(i)) and not self.players[i].resigned for i in (0, 1)]
        if alive[0] and alive[1]:
            return None
        if alive[0] and not alive[1]:
            self.winner = 0
            self.win_reason = "Player 2 has been eradicated."
        elif alive[1] and not alive[0]:
            self.winner = 1
            self.win_reason = "Player 1 has been eradicated."
        return self.winner

class HeuristicBot:
    def __init__(self, owner: int = 1):
        self.owner = owner

    def choose_action(self, state: GameState):
        if state.winner is not None or state.current_owner != self.owner:
            return {"kind": "pass", "label": "Bot idle."}
        if not state.has_starter(self.owner):
            pos = self.choose_starter(state)
            if pos is None:
                return {"kind": "pass", "label": "Bot found no starter."}
            return {"kind": "starter", "pos": pos, "label": f"Bot castle at {pos}."}
        routes, label = self.choose_routes(state)
        if routes:
            return {"kind": "routes", "routes": routes, "label": label}
        return {"kind": "pass", "label": "Bot passed."}

    def choose_starter(self, state: GameState):
        width = state.map.width
        height = state.map.height
        band = max(1, state.settings.start_band)
        xs = range(0, band) if self.owner == 0 else range(width - band, width)
        enemy_castle = state.castle_pos(1 - self.owner)
        target_y = enemy_castle[1] if enemy_castle else height / 2
        best = None
        best_score = -10**9
        for x in xs:
            for y in range(height):
                ok, _ = state.preview_starter(x, y)
                if not ok:
                    continue
                score = -abs(y - target_y)
                if 0 < y < height - 1:
                    score += 1
                if score > best_score:
                    best_score = score
                    best = (x, y)
        return best

    def choose_routes(self, state: GameState):
        candidates = self.generate_candidates(state)
        best_routes = None
        best_label = "Bot passed."
        best_score = -10**18
        for routes, label in candidates:
            sim = state.clone()
            ok, _ = sim.commit_routes(routes)
            if not ok:
                continue
            score = self.score_move(state, sim, label)
            if score > best_score:
                best_score = score
                best_routes = routes
                best_label = label
        return best_routes, best_label

    def generate_candidates(self, state: GameState):
        owner = self.owner
        opponent = 1 - owner
        max_len = min(state.remaining_path, state.max_route_steps(), 8)
        if max_len <= 0:
            return []
        connected_all = list(state.connected_to_castle(owner))
        if not connected_all:
            return []
        own_castle = state.castle_pos(owner)
        enemy_castle = state.castle_pos(opponent)
        sources = self.select_sources(connected_all, own_castle, enemy_castle)
        trees = {src: self.build_search_tree(state, src, max_len) for src in sources}
        candidates = []
        seen = set()

        def add(routes, label):
            if not routes:
                return
            key = tuple(tuple(route) for route in routes)
            if key in seen:
                return
            ok, _, _ = state.evaluate_routes(routes)
            if ok:
                seen.add(key)
                candidates.append((routes, label))

        if enemy_castle:
            for tree in trees.values():
                route = self.route_from_tree(tree, enemy_castle)
                if route:
                    add([route], "Attack castle")

        connected_owner = state.connected_to_castle(owner)
        disconnected = [pos for pos in state.player_nodes(owner) if pos not in connected_owner]
        disconnected.sort(key=lambda p: min(manhattan(p, src) for src in sources))
        for dest in disconnected[:8]:
            route = self.best_route_to_dest(trees, dest)
            if route:
                add([route], "Reconnect cut group")

        if own_castle:
            for dest in self.open_cells_near(state, own_castle, 2):
                routes = self.best_routes_to_open_dest(state, trees, dest, prefer_two=True)
                if routes:
                    add(routes, "Protect castle")

        enemy_nodes = state.player_nodes(opponent)
        if enemy_castle:
            enemy_nodes.sort(key=lambda p: (p != enemy_castle, manhattan(p, enemy_castle), min(manhattan(p, src) for src in sources)))
        else:
            enemy_nodes.sort(key=lambda p: min(manhattan(p, src) for src in sources))
        for dest in enemy_nodes[:12]:
            route = self.best_route_to_dest(trees, dest)
            if route:
                add([route], "Attack node")

        road_cells = []
        seen_cells = set()
        for road in state.player_roads(opponent):
            for cell in road.cells:
                if cell not in seen_cells:
                    seen_cells.add(cell)
                    road_cells.append(cell)
        if enemy_castle:
            road_cells.sort(key=lambda p: (manhattan(p, enemy_castle), min(manhattan(p, src) for src in sources)))
        else:
            road_cells.sort(key=lambda p: min(manhattan(p, src) for src in sources))
        for dest in road_cells[:16]:
            route = self.best_route_to_dest(trees, dest)
            if route:
                add([route], "Cut road")

        redundancy_pairs = []
        for src in sources:
            tree = trees[src]
            for dst in connected_all:
                if dst == src or manhattan(src, dst) <= 1:
                    continue
                if self.has_direct_connection(state, owner, src, dst):
                    continue
                route = self.route_from_tree(tree, dst)
                if not route:
                    continue
                pair_score = 0
                if own_castle and (manhattan(src, own_castle) <= 4 or manhattan(dst, own_castle) <= 4):
                    pair_score += 12
                if enemy_castle:
                    pair_score += max(0, 10 - min(manhattan(dst, enemy_castle), manhattan(src, enemy_castle)))
                pair_score -= len(route)
                redundancy_pairs.append((pair_score, route))
        redundancy_pairs.sort(reverse=True, key=lambda item: item[0])
        for _, route in redundancy_pairs[:14]:
            add([route], "Add redundancy")

        for src, tree in trees.items():
            ranked = []
            for dest in tree["open_cells"]:
                score = self.open_dest_score(state, src, dest, own_castle, enemy_castle)
                ranked.append((score, dest))
            ranked.sort(reverse=True, key=lambda item: item[0])
            for _, dest in ranked[:5]:
                routes = self.best_routes_to_open_dest(state, trees, dest, prefer_two=self.prefers_two_route_node(state, dest, own_castle, enemy_castle))
                if routes:
                    add(routes, "Advance")
        return candidates

    def select_sources(self, connected_all, own_castle, enemy_castle):
        scored = []
        for pos in connected_all:
            attack_bias = manhattan(pos, enemy_castle) if enemy_castle else 0
            defend_bias = manhattan(pos, own_castle) if own_castle else 0
            scored.append((attack_bias, defend_bias, pos))
        attack_sorted = [pos for _, _, pos in sorted(scored)]
        defend_sorted = [pos for _, _, pos in sorted(scored, key=lambda item: item[1])]
        ordered = []
        for pos in ([own_castle] if own_castle in connected_all else []) + attack_sorted + defend_sorted:
            if pos is not None and pos not in ordered:
                ordered.append(pos)
        return ordered[:12]

    def build_search_tree(self, state: GameState, src, max_len):
        min_allowed = max(1, state.map.get(*src) - 1)
        parents = {src: None}
        dist = {src: 0}
        open_cells = []
        q = deque([src])
        while q:
            cur = q.popleft()
            if dist[cur] >= max_len:
                continue
            for nxt in valid_neighbors4(cur[0], cur[1], state.map.width, state.map.height):
                if nxt in parents:
                    continue
                if state.map.get(*nxt) < min_allowed:
                    continue
                if nxt != src and nxt in state.nodes:
                    parents[nxt] = cur
                    dist[nxt] = dist[cur] + 1
                    continue
                road = state.road_at(nxt)
                if road is not None:
                    parents[nxt] = cur
                    dist[nxt] = dist[cur] + 1
                    continue
                parents[nxt] = cur
                dist[nxt] = dist[cur] + 1
                open_cells.append(nxt)
                q.append(nxt)
        return {"src": src, "parents": parents, "dist": dist, "open_cells": open_cells}

    def route_from_tree(self, tree, dest):
        if tree is None or dest not in tree["parents"]:
            return None
        route = []
        cur = dest
        while cur is not None:
            route.append(cur)
            cur = tree["parents"][cur]
        route.reverse()
        return route

    def best_route_to_dest(self, trees, dest):
        best = None
        best_len = 10**9
        for tree in trees.values():
            route = self.route_from_tree(tree, dest)
            if route and len(route) < best_len:
                best = route
                best_len = len(route)
        return best

    def best_routes_to_open_dest(self, state: GameState, trees, dest, prefer_two=False):
        routes = []
        for tree in trees.values():
            route = self.route_from_tree(tree, dest)
            if route:
                routes.append(route)
        if not routes:
            return None
        routes.sort(key=len)
        best = [routes[0]]
        if len(routes) >= 2:
            for route2 in routes[1:5]:
                candidate = [routes[0], route2]
                ok, _, _ = state.evaluate_routes(candidate)
                if ok and (prefer_two or len(routes[0]) <= 4):
                    return candidate
        return best

    def open_cells_near(self, state: GameState, center, radius):
        out = []
        for y in range(state.map.height):
            for x in range(state.map.width):
                pos = (x, y)
                if pos in state.nodes or state.road_at(pos) is not None:
                    continue
                if manhattan(center, pos) <= radius:
                    out.append(pos)
        return out

    def prefers_two_route_node(self, state: GameState, dest, own_castle, enemy_castle):
        if own_castle and manhattan(dest, own_castle) <= 3:
            return True
        if enemy_castle and manhattan(dest, enemy_castle) <= 4:
            return True
        friendly_adj = 0
        for nxt in valid_neighbors4(dest[0], dest[1], state.map.width, state.map.height):
            node = state.nodes.get(nxt)
            if node and node.owner == self.owner:
                friendly_adj += 1
        return friendly_adj >= 2

    def has_direct_connection(self, state: GameState, owner: int, a, b):
        if manhattan(a, b) == 1:
            return True
        for road in state.player_roads(owner):
            if (road.path[0] == a and road.path[-1] == b) or (road.path[0] == b and road.path[-1] == a):
                return True
        return False

    def open_dest_score(self, state: GameState, src, dest, own_castle, enemy_castle):
        score = 0.0
        if enemy_castle:
            score += 6.0 * (manhattan(src, enemy_castle) - manhattan(dest, enemy_castle))
            score += max(0, 8 - manhattan(dest, enemy_castle))
        if own_castle:
            score += max(0, 6 - manhattan(dest, own_castle))
            if manhattan(src, own_castle) <= 2 and manhattan(dest, own_castle) <= 2:
                score += 10
        score += 4 * max(0, state.map.get(*src) - state.map.get(*dest))
        open_neighbors = 0
        friendly_neighbors = 0
        enemy_neighbors = 0
        for nxt in valid_neighbors4(dest[0], dest[1], state.map.width, state.map.height):
            if nxt not in state.nodes and state.road_at(nxt) is None:
                open_neighbors += 1
            else:
                node = state.nodes.get(nxt)
                if node and node.owner == self.owner:
                    friendly_neighbors += 1
                elif node and node.owner != self.owner:
                    enemy_neighbors += 1
        score += 2 * open_neighbors + 4 * friendly_neighbors + 5 * enemy_neighbors
        return score

    def component_graph(self, state: GameState, owner: int):
        active = state.connected_to_castle(owner)
        if not active:
            return {}
        base = state._owner_graph(owner)
        return {pos: {nxt for nxt in base.get(pos, set()) if nxt in active} for pos in active}

    def graph_stats(self, adj):
        if not adj:
            return {"nodes": 0, "edges": 0, "articulation": 0, "bridges": 0}
        timer = 0
        disc = {}
        low = {}
        parent = {}
        articulation = set()
        bridges = 0

        def dfs(u):
            nonlocal timer, bridges
            timer += 1
            disc[u] = low[u] = timer
            child_count = 0
            for v in adj[u]:
                if v not in disc:
                    parent[v] = u
                    child_count += 1
                    dfs(v)
                    low[u] = min(low[u], low[v])
                    if parent.get(u) is None and child_count > 1:
                        articulation.add(u)
                    if parent.get(u) is not None and low[v] >= disc[u]:
                        articulation.add(u)
                    if low[v] > disc[u]:
                        bridges += 1
                elif v != parent.get(u):
                    low[u] = min(low[u], disc[v])

        for u in adj:
            if u not in disc:
                parent[u] = None
                dfs(u)
        edges = sum(len(v) for v in adj.values()) // 2
        return {"nodes": len(adj), "edges": edges, "articulation": len(articulation), "bridges": bridges}

    def castle_safety_score(self, state: GameState, owner: int):
        castle = state.castle_pos(owner)
        if castle is None:
            return -1000.0
        adj = self.component_graph(state, owner)
        castle_degree = len(adj.get(castle, set()))
        adjacent_nodes = 0
        for nxt in valid_neighbors4(castle[0], castle[1], state.map.width, state.map.height):
            node = state.nodes.get(nxt)
            if node and node.owner == owner:
                adjacent_nodes += 1
        enemy = 1 - owner
        enemy_nodes = state.connected_to_castle(enemy)
        enemy_pressure = 0
        for pos in enemy_nodes:
            if manhattan(pos, castle) < state.settings.max_link_distance and state.can_attack_from(pos, castle):
                enemy_pressure += max(1, 4 - min(3, manhattan(pos, castle)))
        return 3.0 * castle_degree + 4.0 * adjacent_nodes - 5.0 * enemy_pressure

    def castle_ring_score(self, state: GameState, owner: int):
        castle = state.castle_pos(owner)
        if castle is None:
            return -1000.0
        score = 0.0
        for pos in state.connected_to_castle(owner):
            d = manhattan(pos, castle)
            if d <= 1:
                score += 4
            elif d == 2:
                score += 2
        return score

    def kill_threat_score(self, state: GameState, owner: int):
        enemy_castle = state.castle_pos(1 - owner)
        if enemy_castle is None:
            return 1000.0
        total = 0.0
        for pos in state.connected_to_castle(owner):
            d = manhattan(pos, enemy_castle)
            if d < state.settings.max_link_distance and state.can_attack_from(pos, enemy_castle):
                total += max(1, state.settings.max_link_distance - d)
        return total

    def redundancy_score(self, state: GameState, owner: int):
        castle = state.castle_pos(owner)
        if castle is None:
            return -1000.0
        adj = self.component_graph(state, owner)
        stats = self.graph_stats(adj)
        castle_degree = len(adj.get(castle, set()))
        cycles = max(0, stats["edges"] - stats["nodes"] + 1)
        return 4.0 * cycles + 3.0 * castle_degree - 3.5 * stats["bridges"]

    def vulnerability_score(self, state: GameState, owner: int):
        adj = self.component_graph(state, owner)
        stats = self.graph_stats(adj)
        castle = state.castle_pos(owner)
        castle_degree = len(adj.get(castle, set())) if castle in adj else 0
        return -(4.0 * stats["bridges"] + 3.0 * stats["articulation"] + max(0, 2 - castle_degree) * 6.0)

    def high_ground_score(self, state: GameState, owner: int):
        my_nodes = list(state.connected_to_castle(owner))
        enemy_nodes = list(state.connected_to_castle(1 - owner))
        total = 0.0
        for pos in my_nodes:
            for target in enemy_nodes:
                d = manhattan(pos, target)
                if d > 4:
                    continue
                if state.can_attack_from(pos, target):
                    total += 5 - d
                if state.can_attack_from(target, pos):
                    total -= 5 - d
        return total

    def mobility_score(self, state: GameState, owner: int):
        active = state.connected_to_castle(owner)
        frontier = set()
        for pos in active:
            for nxt in valid_neighbors4(pos[0], pos[1], state.map.width, state.map.height):
                if nxt in state.nodes or state.road_at(nxt) is not None:
                    continue
                if state.map.get(*nxt) >= max(1, state.map.get(*pos) - 1):
                    frontier.add(nxt)
        return float(len(frontier))

    def local_expansion_score(self, state: GameState, owner: int):
        enemy_castle = state.castle_pos(1 - owner)
        total = 0.0
        for pos in state.connected_to_castle(owner):
            for nxt in valid_neighbors4(pos[0], pos[1], state.map.width, state.map.height):
                if nxt in state.nodes or state.road_at(nxt) is not None:
                    continue
                if state.map.get(*nxt) < max(1, state.map.get(*pos) - 1):
                    continue
                total += 1
                if enemy_castle:
                    total += max(0, 5 - manhattan(nxt, enemy_castle)) * 0.2
        return total

    def forward_pressure_score(self, state: GameState, owner: int):
        active = list(state.connected_to_castle(owner))
        if not active:
            return -1000.0
        enemy_castle = state.castle_pos(1 - owner)
        if enemy_castle:
            dists = [manhattan(pos, enemy_castle) for pos in active]
            scale = state.map.width + state.map.height
            return (scale - min(dists)) + 0.25 * (scale - (sum(dists) / len(dists)))
        xs = [pos[0] for pos in active]
        return float(sum(xs) / len(xs)) if owner == 0 else float(sum(state.map.width - 1 - x for x in xs) / len(xs))

    def score_move(self, before: GameState, after: GameState, label: str):
        owner = self.owner
        opponent = 1 - owner
        if after.winner == owner:
            return 10**9
        if after.winner == opponent:
            return -10**9
        weights = before.settings.bot_weights()
        before_my = len(before.connected_to_castle(owner))
        after_my = len(after.connected_to_castle(owner))
        before_enemy = len(before.connected_to_castle(opponent))
        after_enemy = len(after.connected_to_castle(opponent))
        score = 0.0
        score += weights["castle_survival"] * self.castle_safety_score(after, owner)
        score += weights["castle_protect"] * self.castle_ring_score(after, owner)
        score += weights["castle_kill_threat"] * self.kill_threat_score(after, owner)
        score += weights["disconnect_enemy"] * ((before_enemy - after_enemy) * 6.0)
        score += weights["avoid_disconnect"] * ((after_my - before_my) * 6.0 + self.vulnerability_score(after, owner))
        score += weights["redundancy"] * self.redundancy_score(after, owner)
        score += weights["high_ground"] * self.high_ground_score(after, owner)
        score += weights["mobility"] * self.mobility_score(after, owner)
        score += weights["local_expansion"] * self.local_expansion_score(after, owner)
        score += weights["forward_pressure"] * self.forward_pressure_score(after, owner)
        if label == "Protect castle":
            score += 350
        elif label == "Add redundancy":
            score += 420
        elif label == "Advance":
            score += 260
        elif label == "Reconnect cut group":
            score += 520
        elif label == "Attack castle":
            score += 1600
        elif label == "Cut road":
            score += 520
        elif label == "Attack node":
            score += 260
        return score

def neighbors4(x, y):
    return ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))

def valid_neighbors4(x, y, w, h):
    for nx, ny in neighbors4(x, y):
        if 0 <= nx < w and 0 <= ny < h:
            yield nx, ny

def manhattan(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])

def adjacent8(a, b):
    return a != b and max(abs(a[0] - b[0]), abs(a[1] - b[1])) == 1

def interpolate_cells(a, b):
    ax, ay = a
    bx, by = b
    cells = [(ax, ay)]
    x, y = ax, ay
    while x != bx:
        x += 1 if bx > x else -1
        cells.append((x, y))
    while y != by:
        y += 1 if by > y else -1
        cells.append((x, y))
    return cells
