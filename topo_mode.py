from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass

PLAYER_NAMES = {0: "Player 1", 1: "Player 2"}
ELEVATION_COLORS = {
    1: "#d73027",
    2: "#fc8d59",
    3: "#fee08b",
    4: "#91cf60",
    5: "#4575b4",
}


@dataclass
class TopoNode:
    owner: int
    starter: bool = False


@dataclass
class TopoPath:
    path_id: int
    owner: int
    cells: list[tuple[int, int]]

    @property
    def length(self) -> int:
        return max(0, len(self.cells) - 1)

    @property
    def internal_cells(self) -> set[tuple[int, int]]:
        return set(self.cells[1:-1])


@dataclass
class TopoPlayerState:
    owner: int
    resigned: bool = False


class TopoGameState:
    def __init__(self, settings, map_data):
        self.settings = settings
        self.width = int(map_data.width)
        self.height = int(map_data.height)
        self.grid = [row[:] for row in map_data.grid]
        self.players = [TopoPlayerState(0), TopoPlayerState(1)]
        self.current_owner = 0
        self.winner: int | None = None
        self.win_reason = ""
        self.nodes: dict[tuple[int, int], TopoNode] = {}
        self.paths: dict[int, TopoPath] = {}
        self.path_lookup: dict[tuple[int, int], set[int]] = defaultdict(set)
        self.next_path_id = 1
        self.starter_placed = [False, False]
        self.starter_edge_placed = [False, False]
        self.kill_counts = {0: 0, 1: 0}
        self.starting_nodes_placed = {0: 0, 1: 0}
        self.turn_number = 0
        self.redraw_cooldowns: dict[int, dict[tuple[tuple[int, int], ...], int]] = {0: {}, 1: {}}

    def _momentum_enabled(self) -> bool:
        return bool(getattr(self.settings, "momentum_rule", True))

    def _momentum_bonus_for_segment(self, segment_index: int) -> int:
        if not self._momentum_enabled():
            return 0
        return max(0, int(segment_index))

    def _segment_attack_elevation(self, start: tuple[int, int], segment_index: int) -> int:
        start_elev = self.elevation(start)
        bonus = self._momentum_bonus_for_segment(segment_index)
        return max(1, start_elev - bonus)

    def owner_name(self, owner: int) -> str:
        return PLAYER_NAMES.get(owner, f"Player {owner + 1}")

    def has_starter(self, owner: int) -> bool:
        return any(node.owner == owner and node.starter for node in self.nodes.values())

    def barrier_active(self) -> bool:
        return False

    def _preview_margin_x(self) -> int:
        return 1

    def _preview_margin_y(self) -> int:
        return 1

    def in_bounds(self, pos: tuple[int, int]) -> bool:
        x, y = pos
        return 0 <= x < self.width and 0 <= y < self.height

    def elevation(self, pos: tuple[int, int]) -> int:
        x, y = pos
        return int(self.grid[y][x])

    def castle_pos(self, owner: int) -> tuple[int, int] | None:
        for pos, node in self.nodes.items():
            if node.owner == owner and node.starter:
                return pos
        return None

    def node_at(self, pos: tuple[int, int]) -> TopoNode | None:
        return self.nodes.get(tuple(pos))

    def _is_edge_pos(self, pos: tuple[int, int]) -> bool:
        x, y = pos
        return x == 0 or y == 0 or x == self.width - 1 or y == self.height - 1

    def _is_center_band_x(self, x: int) -> bool:
        # Allow starter placement only in the middle 50% of board columns.
        start = self.width // 4
        end = self.width - start
        return start <= x < end

    def _rebuild_path_lookup(self):
        self.path_lookup = defaultdict(set)
        for path in self.paths.values():
            for cell in path.internal_cells:
                self.path_lookup[cell].add(path.path_id)

    def _expand_board(self):
        add_x = self._preview_margin_x()
        add_y = self._preview_margin_y()
        if add_x <= 0 and add_y <= 0:
            return self.width, self.height, 0, 0
        old_grid = [row[:] for row in self.grid]
        new_w = self.width + add_x * 2
        new_h = self.height + add_y * 2
        new_grid = [[5 for _ in range(new_w)] for _ in range(new_h)]
        for y in range(self.height):
            for x in range(self.width):
                new_grid[y + add_y][x + add_x] = old_grid[y][x]
        self.grid = new_grid
        self.nodes = {(x + add_x, y + add_y): node for (x, y), node in self.nodes.items()}
        for path in self.paths.values():
            path.cells = [(x + add_x, y + add_y) for (x, y) in path.cells]
        self.width = new_w
        self.height = new_h
        self._rebuild_path_lookup()
        return self.width, self.height, add_x, add_y

    def _award_kills(self, owner: int, count: int):
        if count > 0:
            self.kill_counts[owner] = int(self.kill_counts.get(owner, 0)) + int(count)

    def _component_privileges(self, owner: int) -> dict[tuple[int, int], int]:
        # Topostrafe now uses node-specific elevation privilege.
        # A node's privilege is simply the elevation of the square it occupies.
        return {
            pos: self.elevation(pos)
            for pos, node in self.nodes.items()
            if node.owner == owner
        }

    def node_privilege(self, pos: tuple[int, int]) -> int:
        node = self.nodes.get(tuple(pos))
        if node is None:
            return 5
        return self.elevation(tuple(pos))

    def path_privilege(self, path: TopoPath) -> int:
        # Stored paths do not retain origin-node privilege after they are drawn.
        # When crossed, their effective strength comes from the elevation they
        # currently inhabit at the crossed cell.
        if not path.cells:
            return 5
        return min((self.elevation(cell) for cell in path.internal_cells), default=self.elevation(path.cells[0]))

    def current_privilege(self, owner: int) -> int:
        # Global placement unlock is determined by the highest elevation the
        # player has reached with any node. With 5=blue ... 1=red, that is the
        # minimum numeric elevation among the owner's nodes.
        owner_nodes = [pos for pos, node in self.nodes.items() if node.owner == owner]
        if not owner_nodes:
            return 5
        return min(self.elevation(pos) for pos in owner_nodes)

    def _dot_color(self, owner: int) -> str:
        return ELEVATION_COLORS[self.current_privilege(owner)]

    def _min_placeable_elevation(self, owner: int) -> int:
        return max(1, self.current_privilege(owner) - 1)

    def commit_starter(self, x: int, y: int):
        pos = (int(x), int(y))
        if self.winner is not None:
            return False, "Game over."
        if self.has_starter(self.current_owner):
            return False, "Castle already placed."
        if not self.in_bounds(pos):
            return False, "Out of bounds."
        if pos in self.nodes:
            return False, "Cell occupied."
        if self.elevation(pos) != 4:
            return False, "Castle must start on green."
        if not self._is_center_band_x(pos[0]):
            return False, "Castle must be on green within the center 50% of board columns."
        self.nodes[pos] = TopoNode(owner=self.current_owner, starter=True)
        self.starter_placed[self.current_owner] = True
        self.starter_edge_placed[self.current_owner] = False
        return True, "Castle placed."

    def commit_place_node(self, x: int, y: int):
        pos = (int(x), int(y))
        if self.winner is not None:
            return False, "Game over."
        if not self.has_starter(self.current_owner):
            return False, "Place your castle first."
        if not self.in_bounds(pos):
            return False, "Out of bounds."
        if pos in self.nodes:
            return False, "Cell occupied."
        occupant_paths = [self.paths[pid] for pid in sorted(self.path_lookup.get(pos, set())) if pid in self.paths]
        if any(path.owner != self.current_owner for path in occupant_paths):
            return False, "Cannot place a node on an enemy path."
        if self.elevation(pos) < self._min_placeable_elevation(self.current_owner):
            return False, "That elevation is not unlocked yet."
        enemy_owner = 1 - self.current_owner
        enemy_enclosed = self._enclosed_cells_for_owner(enemy_owner)
        if pos in enemy_enclosed:
            return False, "Cannot place a node inside enemy-encircled territory."
        self.nodes[pos] = TopoNode(owner=self.current_owner, starter=False)
        split_count = 0
        for path in occupant_paths:
            if pos not in path.internal_cells:
                continue
            split_count += self._split_path_with_node(path.path_id, pos)
        removed = self._resolve_after_action(self.current_owner)
        expanded = False
        new_w = self.width
        new_h = self.height
        if self._is_edge_pos(pos):
            new_w, new_h, _, _ = self._expand_board()
            expanded = True
        msg = "Node placed."
        if split_count:
            msg = f"{msg} Split {split_count} path segment{'s' if split_count != 1 else ''}."
        if removed:
            msg = f"{msg} {removed}".strip()
        if expanded:
            msg = f"{msg} Board expanded to {new_w}x{new_h}.".strip()
        return True, msg

    def commit_place_paths(self, segments: list[list[tuple[int, int]]]):
        if self.winner is not None:
            return False, "Game over."
        owner = self.current_owner
        if not self.has_starter(owner):
            return False, "Place your castle first."
        norm_segments: list[list[tuple[int, int]]] = []
        for seg in segments:
            norm = [(int(x), int(y)) for x, y in seg]
            if norm:
                norm_segments.append(norm)
        if not norm_segments:
            return False, "No paths selected."

        new_internal_cells: set[tuple[int, int]] = set()
        remove_enemy_paths: set[int] = set()
        cut_enemy_path_signatures: dict[int, set[tuple[tuple[int, int], ...]]] = {0: set(), 1: set()}
        remove_enemy_nodes: set[tuple[int, int]] = set()
        prev_end: tuple[int, int] | None = None
        used_start_nodes: set[tuple[int, int]] = set()
        to_add: list[TopoPath] = []
        my_priv = 5

        for seg_index, seg in enumerate(norm_segments):
            ok, msg = self._validate_segment(seg, owner, prev_end, new_internal_cells, used_start_nodes, seg_index)
            if not ok:
                return False, msg
            seg_internal = set(seg[1:-1])
            seg_length = len(seg) - 1
            seg_priv = self._segment_attack_elevation(seg[0], seg_index)
            crossed_enemy: set[int] = set()
            for cell in seg_internal:
                node = self.nodes.get(cell)
                if node is not None:
                    if node.owner == owner:
                        return False, "Paths cannot pass through your own nodes."
                    if node.starter:
                        return False, "You cannot draw through the enemy castle."
                    remove_enemy_nodes.add(cell)
                for pid in self.path_lookup.get(cell, set()):
                    path = self.paths.get(pid)
                    if path is None:
                        continue
                    if path.owner == owner:
                        return False, "Cannot cross your own paths."
                    seg_axis = self._segment_axis_at_cell(seg, cell)
                    path_axis = self._path_axis_at_cell(path, cell)
                    if seg_axis is None or path_axis is None or seg_axis == path_axis:
                        return False, "You may only cross enemy paths perpendicularly, not along them."
                    crossed_enemy.add(pid)
            for pid in crossed_enemy:
                path = self.paths.get(pid)
                if path is None:
                    continue
                crossed_cells = seg_internal & path.internal_cells
                crossed_elevation = min((self.elevation(cell) for cell in crossed_cells), default=5)
                if not (seg_length < path.length or seg_priv < crossed_elevation):
                    return False, "That enemy path is too strong to cut from this start elevation."
                remove_enemy_paths.add(pid)
                cut_enemy_path_signatures[path.owner].add(self._path_signature(path.cells))
            path = TopoPath(self.next_path_id, owner, seg[:])
            self.next_path_id += 1
            to_add.append(path)
            new_internal_cells.update(seg_internal)
            used_start_nodes.add(seg[0])
            prev_end = seg[-1]

        for pid in sorted(remove_enemy_paths):
            self._remove_path(pid)
        blocked_until_turn = self.turn_number + 1
        for blocked_owner, signatures in cut_enemy_path_signatures.items():
            if not signatures:
                continue
            cooldowns = self.redraw_cooldowns[blocked_owner]
            for signature in signatures:
                cooldowns[signature] = max(cooldowns.get(signature, -1), blocked_until_turn)
        for path in to_add:
            self.paths[path.path_id] = path
            for cell in path.internal_cells:
                self.path_lookup[cell].add(path.path_id)

        removed_by_path = 0
        removed_attached_paths = 0
        for pos in sorted(remove_enemy_nodes):
            removed = self._remove_node(pos)
            if removed is None:
                continue
            removed_by_path += 1
            removed_attached_paths += self._count_paths_touching_owner_node(pos, removed.owner)
            self._remove_paths_touching_owner_node(pos, removed.owner)
            if removed.starter:
                self.winner = owner
                self.win_reason = f"{self.owner_name(owner)} captured the enemy castle."
        self._award_kills(owner, removed_by_path)
        removed = ""
        if self.winner is None:
            removed = self._resolve_after_action(owner)
        msg = f"Placed {len(to_add)} path{'s' if len(to_add) != 1 else ''}."
        if remove_enemy_paths:
            msg = f"{msg} Cut {len(remove_enemy_paths)} enemy path{'s' if len(remove_enemy_paths) != 1 else ''}."
        if removed_by_path:
            msg = f"{msg} Killed {removed_by_path} enemy node{'s' if removed_by_path != 1 else ''}."
        if removed_attached_paths:
            msg = f"{msg} Removed {removed_attached_paths} attached enemy path{'s' if removed_attached_paths != 1 else ''}."
        if removed:
            msg = f"{msg} {removed}".strip()
        if self.winner is not None and not removed:
            msg = f"{msg} {self.win_reason}".strip()
        return True, msg

    def _validate_segment(self, seg, owner, prev_end, new_internal_cells, used_start_nodes, segment_index=0):
        if len(seg) < 2:
            return False, "Each path segment must connect two friendly nodes."
        if len(set(seg)) != len(seg):
            return False, "A path segment cannot revisit cells."
        for pos in seg:
            if not self.in_bounds(pos):
                return False, "Path is out of bounds."
        start = seg[0]
        end = seg[-1]
        if prev_end is not None and start != prev_end:
            return False, "A chain must continue from the previous node."
        start_node = self.nodes.get(start)
        end_node = self.nodes.get(end)
        if start_node is None or start_node.owner != owner:
            return False, "Path must start on a friendly node."
        if end_node is None or end_node.owner != owner:
            return False, "Path must end on a friendly node."
        signature = self._path_signature(seg)
        blocked_until = self.redraw_cooldowns.get(owner, {}).get(signature)
        if blocked_until is not None and self.turn_number <= blocked_until:
            return False, "That exact path was just cut; wait one turn before redrawing it."
        if end in used_start_nodes:
            return False, "You cannot end a segment on a node that already started one earlier this turn."
        if self.elevation(start) < self._min_placeable_elevation(owner) or self.elevation(end) < self._min_placeable_elevation(owner):
            return False, "That elevation is not unlocked yet."
        origin_elev = self._segment_attack_elevation(start, segment_index)
        for cell in seg:
            if self.elevation(cell) < origin_elev:
                return False, "That path crosses terrain above this chain's current elevation advantage."
        for a, b in zip(seg, seg[1:]):
            if abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
                return False, "Paths must move one square orthogonally at a time."
        if self._count_corners(seg) > 1:
            return False, "This mode allows at most 1 corner per segment."
        for cell in seg[1:-1]:
            node = self.nodes.get(cell)
            if node is not None and node.owner == owner:
                return False, "Paths cannot pass through your own nodes."
            if cell in new_internal_cells:
                return False, "New path segments cannot overlap each other except at nodes."
        return True, "OK"

    @staticmethod
    def _count_corners(seg):
        if len(seg) < 3:
            return 0
        corners = 0
        prev_dir = None
        for a, b in zip(seg, seg[1:]):
            d = (b[0] - a[0], b[1] - a[1])
            if prev_dir is not None and d != prev_dir:
                corners += 1
            prev_dir = d
        return corners

    @staticmethod
    def _axis_from_pair(a, b):
        if a[0] != b[0]:
            return 'h'
        if a[1] != b[1]:
            return 'v'
        return ''

    @staticmethod
    def _path_signature(cells):
        forward = tuple(cells)
        reverse = tuple(reversed(cells))
        return forward if forward <= reverse else reverse

    def _path_axis_at_cell(self, path, cell):
        try:
            idx = path.cells.index(cell)
        except ValueError:
            return None
        if idx <= 0 or idx >= len(path.cells) - 1:
            return None
        a = self._axis_from_pair(path.cells[idx - 1], cell)
        b = self._axis_from_pair(cell, path.cells[idx + 1])
        return a if a == b else None

    def _segment_axis_at_cell(self, seg, cell):
        try:
            idx = seg.index(cell)
        except ValueError:
            return None
        if idx <= 0 or idx >= len(seg) - 1:
            return None
        a = self._axis_from_pair(seg[idx - 1], cell)
        b = self._axis_from_pair(cell, seg[idx + 1])
        return a if a == b else None

    def _remove_path(self, pid):
        path = self.paths.pop(pid, None)
        if path is None:
            return
        for cell in path.internal_cells:
            ids = self.path_lookup.get(cell)
            if not ids:
                continue
            ids.discard(pid)
            if not ids:
                self.path_lookup.pop(cell, None)

    def _remove_node(self, pos):
        return self.nodes.pop(pos, None)

    def _split_path_with_node(self, pid, pos):
        path = self.paths.get(pid)
        if path is None or pos not in path.internal_cells:
            return 0
        idx = path.cells.index(pos)
        cells = path.cells[:]
        owner = path.owner
        self._remove_path(pid)
        created = 0
        for piece in [cells[:idx + 1], cells[idx:]]:
            if len(piece) < 2:
                continue
            new_path = TopoPath(self.next_path_id, owner, piece)
            self.next_path_id += 1
            self.paths[new_path.path_id] = new_path
            for cell in new_path.internal_cells:
                self.path_lookup[cell].add(new_path.path_id)
            created += 1
        return created

    def _remove_paths_touching_owner_node(self, pos, owner):
        for pid, path in list(self.paths.items()):
            if path.owner == owner and pos in path.cells:
                self._remove_path(pid)

    def _count_paths_touching_owner_node(self, pos, owner):
        return sum(1 for path in self.paths.values() if path.owner == owner and pos in path.cells)

    def _resolve_after_action(self, owner):
        removed_nodes = 0
        removed_paths = 0
        surround_kills = self._orth_node_surround_kills(owner)
        for pos in surround_kills:
            removed = self._remove_node(pos)
            if removed is not None:
                removed_nodes += 1
                removed_paths += self._count_paths_touching_owner_node(pos, removed.owner)
                self._remove_paths_touching_owner_node(pos, removed.owner)
                if removed.starter:
                    self.winner = owner
                    self.win_reason = f"{self.owner_name(owner)} captured the enemy castle."
        if self.winner is not None:
            self._award_kills(owner, removed_nodes)
            return "Castle captured."
        enclosed_cells = self._enclosed_cells_for_owner(owner)
        if enclosed_cells:
            enemy_nodes = [pos for pos, node in list(self.nodes.items()) if node.owner != owner and pos in enclosed_cells]
            for pos in enemy_nodes:
                removed = self._remove_node(pos)
                if removed is not None:
                    removed_nodes += 1
                    removed_paths += self._count_paths_touching_owner_node(pos, removed.owner)
                    self._remove_paths_touching_owner_node(pos, removed.owner)
                    if removed.starter:
                        self.winner = owner
                        self.win_reason = f"{self.owner_name(owner)} encircled the enemy castle."
            enemy_paths = [pid for pid, path in list(self.paths.items()) if path.owner != owner and all(cell in enclosed_cells for cell in path.cells)]
            for pid in enemy_paths:
                if pid in self.paths:
                    self._remove_path(pid)
                    removed_paths += 1
        if self.winner is not None:
            self._award_kills(owner, removed_nodes)
            return "Enemy castle destroyed."
        self._award_kills(owner, removed_nodes)
        bits = []
        if removed_nodes:
            bits.append(f"{removed_nodes} enemy node{'s' if removed_nodes != 1 else ''} removed.")
        if removed_paths:
            bits.append(f"{removed_paths} enemy path{'s' if removed_paths != 1 else ''} removed.")
        return " ".join(bits)

    def _orth_node_surround_kills(self, owner):
        kills = set()
        enemy = 1 - owner
        owner_walls = self._owner_wall_cells(owner)
        for pos, node in self.nodes.items():
            if node.owner != enemy:
                continue
            surrounded = True
            x, y = pos
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                np = (x + dx, y + dy)
                if not self.in_bounds(np):
                    surrounded = False
                    break
                if np not in owner_walls:
                    surrounded = False
                    break
            if surrounded:
                kills.add(pos)
        return kills

    def _owner_wall_cells(self, owner):
        blocked = {pos for pos, node in self.nodes.items() if node.owner == owner}
        for path in self.paths.values():
            if path.owner == owner:
                blocked.update(path.cells)
        return blocked

    def _path_region_components_for_paths(self, paths):
        if not paths:
            return []
        micro_w = self.width * 2 + 1
        micro_h = self.height * 2 + 1
        occupied = set()
        def center(cell):
            return (cell[0] * 2 + 1, cell[1] * 2 + 1)
        for path in paths:
            prev_center = None
            for cell in path.cells:
                c = center(cell)
                occupied.add(c)
                if prev_center is not None:
                    mid = ((prev_center[0] + c[0]) // 2, (prev_center[1] + c[1]) // 2)
                    occupied.add(mid)
                prev_center = c
        outside = set()
        q = deque()
        def seed(pt):
            if pt in occupied or pt in outside:
                return
            outside.add(pt)
            q.append(pt)
        for x in range(micro_w):
            seed((x,0)); seed((x,micro_h-1))
        for y in range(micro_h):
            seed((0,y)); seed((micro_w-1,y))
        while q:
            x,y = q.popleft()
            for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                np=(x+dx,y+dy)
                if not (0 <= np[0] < micro_w and 0 <= np[1] < micro_h):
                    continue
                if np in occupied or np in outside:
                    continue
                outside.add(np)
                q.append(np)
        candidate=set()
        for x in range(self.width):
            for y in range(self.height):
                c=center((x,y))
                if c in occupied:
                    continue
                if c not in outside:
                    candidate.add((x,y))
        comps=[]
        seen=set()
        for start in list(candidate):
            if start in seen:
                continue
            comp=set(); q=deque([start]); seen.add(start)
            while q:
                cur=q.popleft(); comp.add(cur)
                x,y=cur
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    np=(x+dx,y+dy)
                    if np not in candidate or np in seen:
                        continue
                    seen.add(np); q.append(np)
            comps.append(comp)
        return comps

    def _owner_graph(self, owner):
        graph = {pos: set() for pos, node in self.nodes.items() if node.owner == owner}
        for path in self.paths.values():
            if path.owner != owner or len(path.cells) < 2:
                continue
            a, b = path.cells[0], path.cells[-1]
            if a in graph and b in graph:
                graph[a].add(b); graph[b].add(a)
        return graph

    def _owner_component_paths(self, owner):
        graph = self._owner_graph(owner)
        seen=set(); comps=[]
        for start in graph:
            if start in seen:
                continue
            q=deque([start]); seen.add(start); nodes=set([start])
            while q:
                cur=q.popleft()
                for nxt in graph[cur]:
                    if nxt in seen: continue
                    seen.add(nxt); q.append(nxt); nodes.add(nxt)
            path_ids=[]
            for pid, path in self.paths.items():
                if path.owner == owner and len(path.cells) >= 2 and path.cells[0] in nodes and path.cells[-1] in nodes:
                    path_ids.append(pid)
            comps.append((nodes, path_ids))
        return comps

    def _enclosed_cells_for_owner(self, owner):
        enclosed=set()
        for _, path_ids in self._owner_component_paths(owner):
            paths=[self.paths[pid] for pid in path_ids if pid in self.paths]
            for comp in self._path_region_components_for_paths(paths):
                enclosed.update(comp)
        return enclosed

    def check_winner(self):
        if self.winner is not None:
            return
        for owner, player in enumerate(self.players):
            if player.resigned:
                self.winner = 1 - owner
                self.win_reason = f"{self.owner_name(owner)} resigned."
                return
        for owner in (0,1):
            if self.has_starter(owner):
                continue
            if self.starter_placed[owner]:
                self.winner = 1 - owner
                self.win_reason = f"{self.owner_name(owner)} lost the castle."
                return

    def end_turn(self):
        self.check_winner()
        if self.winner is not None:
            return False, self.win_reason or "Game over."
        self.current_owner = 1 - self.current_owner
        self.turn_number += 1
        return True, f"{self.owner_name(self.current_owner)} to move."
