from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Iterable

PLAYER_NAMES = {0: "Player 1", 1: "Player 2"}
BOARD_COLORS = {
    "yellow": "#f3ebb8",
    "blue": "#7ba6f5",
    "green": "#84c96f",
    "gray": "#b6b6b6",
}
SIZE_PRESETS = {
    "small": (6, 6),
    "medium": (10, 10),
    "large": (20, 20),
}


@dataclass
class UmSettings:
    board_width: int = 10
    board_height: int = 10
    max_corners: int = 1
    board_color: str = "yellow"
    require_move_confirmation: bool = False
    infinite_board: bool = True
    time_limit_enabled: bool = False
    time_bank_seconds: int = 600


@dataclass
class UmNode:
    owner: int
    starter: bool = False


@dataclass
class UmPath:
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
class UmPlayerState:
    owner: int
    resigned: bool = False


class UmGameState:
    def __init__(self, settings: UmSettings):
        self.settings = settings
        self.width = int(settings.board_width)
        self.height = int(settings.board_height)
        self.players = [UmPlayerState(0), UmPlayerState(1)]
        self.current_owner = 0
        self.winner: int | None = None
        self.win_reason = ""
        self.nodes: dict[tuple[int, int], UmNode] = {}
        self.paths: dict[int, UmPath] = {}
        self.path_lookup: dict[tuple[int, int], set[int]] = defaultdict(set)
        self.next_path_id = 1
        self.starter_placed = [False, False]

    def has_starter(self, owner: int) -> bool:
        return any(node.owner == owner and node.starter for node in self.nodes.values())

    def _preview_margin_x(self) -> int:
        if not getattr(self.settings, "infinite_board", False):
            return 0
        return 1

    def _preview_margin_y(self) -> int:
        if not getattr(self.settings, "infinite_board", False):
            return 0
        return 1

    def _is_edge_pos(self, pos: tuple[int, int]) -> bool:
        x, y = pos
        return x == 0 or y == 0 or x == self.width - 1 or y == self.height - 1

    def _rebuild_path_lookup(self):
        self.path_lookup = defaultdict(set)
        for path in self.paths.values():
            for cell in path.internal_cells:
                self.path_lookup[cell].add(path.path_id)

    def _expand_board(self) -> tuple[int, int, int, int]:
        add_x = self._preview_margin_x()
        add_y = self._preview_margin_y()
        if add_x <= 0 and add_y <= 0:
            return self.width, self.height, 0, 0
        if add_x:
            self.nodes = {(x + add_x, y): node for (x, y), node in self.nodes.items()}
        if add_y:
            self.nodes = {(x, y + add_y): node for (x, y), node in self.nodes.items()}
        for path in self.paths.values():
            path.cells = [(x + add_x, y + add_y) for (x, y) in path.cells]
        self.width += add_x * 2
        self.height += add_y * 2
        self._rebuild_path_lookup()
        return self.width, self.height, add_x, add_y

    def node_at(self, pos: tuple[int, int]) -> UmNode | None:
        return self.nodes.get(tuple(pos))

    def in_bounds(self, pos: tuple[int, int]) -> bool:
        x, y = pos
        return 0 <= x < self.width and 0 <= y < self.height

    def castle_pos(self, owner: int) -> tuple[int, int] | None:
        for pos, node in self.nodes.items():
            if node.owner == owner and node.starter:
                return pos
        return None

    def owner_name(self, owner: int) -> str:
        return PLAYER_NAMES.get(owner, f"Player {owner + 1}")

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
        mid = self.width / 2.0
        if self.current_owner == 0 and not (x < mid):
            return False, "Player 1 castle must be on the left side."
        if self.current_owner == 1 and not (x >= mid):
            return False, "Player 2 castle must be on the right side."
        self.nodes[pos] = UmNode(owner=self.current_owner, starter=True)
        self.starter_placed[self.current_owner] = True
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
        enemy_owner = 1 - self.current_owner
        enemy_enclosed = self._enclosed_cells_for_owner(enemy_owner)
        if pos in enemy_enclosed:
            return False, "Cannot place a node inside enemy-encircled territory."

        # Snapshot the minimal mutable state so we can reject self-snuffing placements cleanly.
        nodes_snapshot = dict(self.nodes)
        paths_snapshot = {pid: UmPath(path.path_id, path.owner, path.cells[:]) for pid, path in self.paths.items()}
        path_lookup_snapshot = defaultdict(set, {cell: set(ids) for cell, ids in self.path_lookup.items()})
        next_path_id_snapshot = self.next_path_id

        self.nodes[pos] = UmNode(owner=self.current_owner, starter=False)
        split_count = 0
        for path in occupant_paths:
            if pos not in path.internal_cells:
                continue
            split_count += self._split_path_with_node(path.path_id, pos)

        enemy_wall_snuffed = self._wall_snuffed_cells_for_owner(enemy_owner)
        if pos in enemy_wall_snuffed:
            self.nodes = nodes_snapshot
            self.paths = paths_snapshot
            self.path_lookup = path_lookup_snapshot
            self.next_path_id = next_path_id_snapshot
            return False, "You cannot place a node where the enemy could immediately snuff it out against the wall."

        removed = self._resolve_after_action(self.current_owner)
        expanded = False
        new_w = self.width
        new_h = self.height
        if getattr(self.settings, "infinite_board", False) and self._is_edge_pos(pos):
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
        remove_enemy_nodes: set[tuple[int, int]] = set()
        prev_end: tuple[int, int] | None = None
        used_start_nodes: set[tuple[int, int]] = set()
        to_add: list[UmPath] = []

        for seg in norm_segments:
            ok, msg = self._validate_segment(seg, owner, prev_end, new_internal_cells, used_start_nodes)
            if not ok:
                return False, msg
            seg_internal = set(seg[1:-1])
            seg_length = len(seg) - 1
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
                if seg_length >= path.length:
                    return False, "A crossing path must be shorter than the enemy path it cuts."
                remove_enemy_paths.add(pid)
            path = UmPath(self.next_path_id, owner, seg[:])
            self.next_path_id += 1
            to_add.append(path)
            new_internal_cells.update(seg_internal)
            used_start_nodes.add(seg[0])
            prev_end = seg[-1]

        for pid in sorted(remove_enemy_paths):
            self._remove_path(pid)
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

    def _validate_segment(self, seg: list[tuple[int, int]], owner: int, prev_end: tuple[int, int] | None, new_internal_cells: set[tuple[int, int]], used_start_nodes: set[tuple[int, int]]):
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
        if end in used_start_nodes:
            return False, "You cannot end a segment on a node that already started one earlier this turn."
        for a, b in zip(seg, seg[1:]):
            if abs(a[0] - b[0]) + abs(a[1] - b[1]) != 1:
                return False, "Paths must move one square orthogonally at a time."
        if self._count_corners(seg) > max(0, int(self.settings.max_corners)):
            return False, f"This mode allows at most {int(self.settings.max_corners)} corner{'s' if int(self.settings.max_corners) != 1 else ''} per segment."
        for cell in seg[1:-1]:
            node = self.nodes.get(cell)
            if node is not None and node.owner == owner:
                return False, "Paths cannot pass through your own nodes."
            if cell in new_internal_cells:
                return False, "New path segments cannot overlap each other except at nodes."
        return True, "OK"

    @staticmethod
    def _count_corners(seg: list[tuple[int, int]]) -> int:
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
    def _axis_from_pair(a: tuple[int, int], b: tuple[int, int]) -> str:
        if a[0] != b[0]:
            return 'h'
        if a[1] != b[1]:
            return 'v'
        return ''

    def _path_axis_at_cell(self, path: UmPath, cell: tuple[int, int]) -> str | None:
        try:
            idx = path.cells.index(cell)
        except ValueError:
            return None
        if idx <= 0 or idx >= len(path.cells) - 1:
            return None
        a = self._axis_from_pair(path.cells[idx - 1], cell)
        b = self._axis_from_pair(cell, path.cells[idx + 1])
        return a if a == b else None

    def _segment_axis_at_cell(self, seg: list[tuple[int, int]], cell: tuple[int, int]) -> str | None:
        try:
            idx = seg.index(cell)
        except ValueError:
            return None
        if idx <= 0 or idx >= len(seg) - 1:
            return None
        a = self._axis_from_pair(seg[idx - 1], cell)
        b = self._axis_from_pair(cell, seg[idx + 1])
        return a if a == b else None

    def _remove_path(self, pid: int):
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

    def _remove_node(self, pos: tuple[int, int]):
        node = self.nodes.pop(pos, None)
        if node is None:
            return None
        return node

    def _split_path_with_node(self, pid: int, pos: tuple[int, int]) -> int:
        path = self.paths.get(pid)
        if path is None or pos not in path.internal_cells:
            return 0
        try:
            idx = path.cells.index(pos)
        except ValueError:
            return 0
        cells = path.cells[:]
        owner = path.owner
        self._remove_path(pid)
        created = 0
        pieces = [cells[:idx + 1], cells[idx:]]
        for piece in pieces:
            if len(piece) < 2:
                continue
            new_path = UmPath(self.next_path_id, owner, piece)
            self.next_path_id += 1
            self.paths[new_path.path_id] = new_path
            for cell in new_path.internal_cells:
                self.path_lookup[cell].add(new_path.path_id)
            created += 1
        return created

    def _remove_paths_touching_owner_node(self, pos: tuple[int, int], owner: int):
        for pid, path in list(self.paths.items()):
            if path.owner != owner:
                continue
            if pos in path.cells:
                self._remove_path(pid)

    def _count_paths_touching_owner_node(self, pos: tuple[int, int], owner: int) -> int:
        count = 0
        for path in self.paths.values():
            if path.owner != owner:
                continue
            if pos in path.cells:
                count += 1
        return count

    def _resolve_after_action(self, owner: int) -> str:
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
            return "Castle captured."

        enclosed_cells = self._enclosed_cells_for_owner(owner)
        wall_snuffed_cells = self._wall_snuffed_cells_for_owner(owner)
        kill_cells = enclosed_cells | wall_snuffed_cells
        if kill_cells:
            enemy_nodes = [pos for pos, node in list(self.nodes.items()) if node.owner != owner and pos in kill_cells]
            for pos in enemy_nodes:
                removed = self._remove_node(pos)
                if removed is not None:
                    removed_nodes += 1
                    removed_paths += self._count_paths_touching_owner_node(pos, removed.owner)
                    self._remove_paths_touching_owner_node(pos, removed.owner)
                    if removed.starter:
                        self.winner = owner
                        if pos in wall_snuffed_cells:
                            self.win_reason = f"{self.owner_name(owner)} snuffed out the enemy castle against the wall."
                        else:
                            self.win_reason = f"{self.owner_name(owner)} encircled the enemy castle."
            enemy_paths = [pid for pid, path in list(self.paths.items()) if path.owner != owner and all(cell in kill_cells for cell in path.cells)]
            for pid in enemy_paths:
                if pid in self.paths:
                    self._remove_path(pid)
                    removed_paths += 1

        if self.winner is not None:
            return "Enemy castle destroyed."
        bits = []
        if removed_nodes:
            bits.append(f"{removed_nodes} enemy node{'s' if removed_nodes != 1 else ''} removed.")
        if removed_paths:
            bits.append(f"{removed_paths} enemy path{'s' if removed_paths != 1 else ''} removed.")
        return " ".join(bits)

    def _orth_node_surround_kills(self, owner: int) -> set[tuple[int, int]]:
        kills: set[tuple[int, int]] = set()
        enemy = 1 - owner
        owner_walls = self._owner_wall_cells(owner)
        for pos, node in self.nodes.items():
            if node.owner != enemy:
                continue
            surrounded = True
            x, y = pos
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                np = (x + dx, y + dy)
                if not self.in_bounds(np):
                    if getattr(self.settings, "infinite_board", False):
                        surrounded = False
                        break
                    continue
                if np not in owner_walls:
                    surrounded = False
                    break
            if surrounded:
                kills.add(pos)
        return kills

    def _owner_wall_cells(self, owner: int) -> set[tuple[int, int]]:
        blocked: set[tuple[int, int]] = {pos for pos, node in self.nodes.items() if node.owner == owner}
        for path in self.paths.values():
            if path.owner != owner:
                continue
            blocked.update(path.cells)
        return blocked

    def _owner_path_cells(self, owner: int) -> set[tuple[int, int]]:
        blocked: set[tuple[int, int]] = set()
        for path in self.paths.values():
            if path.owner != owner:
                continue
            blocked.update(path.cells or [])
        return blocked

    def _path_region_components(self, owner: int, blocked_edges: tuple[str, ...] = ()) -> list[set[tuple[int, int]]]:
        owner_paths = [path for path in self.paths.values() if path.owner == owner and len(path.cells) >= 2]
        if not owner_paths:
            return []

        micro_w = self.width * 2 + 1
        micro_h = self.height * 2 + 1
        occupied: set[tuple[int, int]] = set()

        def center(cell: tuple[int, int]) -> tuple[int, int]:
            return (cell[0] * 2 + 1, cell[1] * 2 + 1)

        for path in owner_paths:
            prev_center = None
            for cell in path.cells:
                c = center(cell)
                occupied.add(c)
                if prev_center is not None:
                    mid = ((prev_center[0] + c[0]) // 2, (prev_center[1] + c[1]) // 2)
                    occupied.add(mid)
                prev_center = c

        blocked = set(occupied)
        blocked_edge_set = set(blocked_edges)
        if 'top' in blocked_edge_set:
            blocked.update((x, 0) for x in range(micro_w))
        if 'bottom' in blocked_edge_set:
            blocked.update((x, micro_h - 1) for x in range(micro_w))
        if 'left' in blocked_edge_set:
            blocked.update((0, y) for y in range(micro_h))
        if 'right' in blocked_edge_set:
            blocked.update((micro_w - 1, y) for y in range(micro_h))

        outside: set[tuple[int, int]] = set()
        q = deque()

        def seed_boundary(pt: tuple[int, int]):
            if pt in blocked or pt in outside:
                return
            outside.add(pt)
            q.append(pt)

        for x in range(micro_w):
            seed_boundary((x, 0))
            seed_boundary((x, micro_h - 1))
        for y in range(micro_h):
            seed_boundary((0, y))
            seed_boundary((micro_w - 1, y))

        while q:
            x, y = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                np = (x + dx, y + dy)
                if not (0 <= np[0] < micro_w and 0 <= np[1] < micro_h):
                    continue
                if np in blocked or np in outside:
                    continue
                outside.add(np)
                q.append(np)

        candidate: set[tuple[int, int]] = set()
        for x in range(self.width):
            for y in range(self.height):
                c = center((x, y))
                if c in blocked:
                    continue
                if c not in outside:
                    candidate.add((x, y))

        comps: list[set[tuple[int, int]]] = []
        seen: set[tuple[int, int]] = set()
        for start in list(candidate):
            if start in seen:
                continue
            comp = set()
            q = deque([start])
            seen.add(start)
            while q:
                cur = q.popleft()
                comp.add(cur)
                x, y = cur
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    np = (x + dx, y + dy)
                    if np not in candidate or np in seen:
                        continue
                    seen.add(np)
                    q.append(np)
            comps.append(comp)
        return comps

    def _enclosed_cells_for_owner(self, owner: int) -> set[tuple[int, int]]:
        enclosed = set()
        for comp in self._path_region_components(owner):
            enclosed.update(comp)

        if getattr(self.settings, "infinite_board", False):
            return enclosed

        edge_specs = (
            ('top', lambda cell: cell[1] == 0, lambda cell: cell[1] == self.height - 1 or cell[0] == 0 or cell[0] == self.width - 1),
            ('bottom', lambda cell: cell[1] == self.height - 1, lambda cell: cell[1] == 0 or cell[0] == 0 or cell[0] == self.width - 1),
            ('left', lambda cell: cell[0] == 0, lambda cell: cell[0] == self.width - 1 or cell[1] == 0 or cell[1] == self.height - 1),
            ('right', lambda cell: cell[0] == self.width - 1, lambda cell: cell[0] == 0 or cell[1] == 0 or cell[1] == self.height - 1),
        )
        for edge_name, on_edge, on_other_edge in edge_specs:
            for comp in self._path_region_components(owner, (edge_name,)):
                touches_chosen = any(on_edge(cell) for cell in comp)
                touches_other = any(on_other_edge(cell) for cell in comp)
                if touches_chosen and not touches_other:
                    enclosed.update(comp)
        return enclosed

    def _node_has_enemy_contact_8(self, owner: int, pos: tuple[int, int]) -> bool:
        owner_walls = self._owner_wall_cells(owner)
        x, y = pos
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                np = (x + dx, y + dy)
                if not self.in_bounds(np):
                    continue
                if np in owner_walls:
                    return True
        return False

    def _wall_snuffed_cells_for_owner(self, owner: int) -> set[tuple[int, int]]:
        if getattr(self.settings, "infinite_board", False):
            return set()
        enemy = 1 - owner
        owner_walls = self._owner_wall_cells(owner)
        enemy_cells: set[tuple[int, int]] = set()
        for pos, node in self.nodes.items():
            if node.owner == enemy:
                enemy_cells.add(pos)
        for path in self.paths.values():
            if path.owner == enemy:
                enemy_cells.update(path.cells)
        if not enemy_cells:
            return set()

        comps: list[set[tuple[int, int]]] = []
        seen: set[tuple[int, int]] = set()
        for start in list(enemy_cells):
            if start in seen:
                continue
            comp = set()
            q = deque([start])
            seen.add(start)
            while q:
                cur = q.popleft()
                comp.add(cur)
                x, y = cur
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    np = (x + dx, y + dy)
                    if np not in enemy_cells or np in seen:
                        continue
                    seen.add(np)
                    q.append(np)
            comps.append(comp)

        snuffed: set[tuple[int, int]] = set()
        for comp in comps:
            touches_edge = any(x == 0 or y == 0 or x == self.width - 1 or y == self.height - 1 for x, y in comp)
            if not touches_edge:
                continue
            enemy_nodes_in_comp = [pos for pos, node in self.nodes.items() if node.owner == enemy and pos in comp]
            if enemy_nodes_in_comp and any(not self._node_has_enemy_contact_8(owner, pos) for pos in enemy_nodes_in_comp):
                continue

            blocked = owner_walls | comp
            outside: set[tuple[int, int]] = set()
            q = deque()

            def seed(cell: tuple[int, int]):
                if not self.in_bounds(cell) or cell in blocked or cell in outside:
                    return
                outside.add(cell)
                q.append(cell)

            for x in range(self.width):
                seed((x, 0))
                seed((x, self.height - 1))
            for y in range(self.height):
                seed((0, y))
                seed((self.width - 1, y))

            while q:
                cx, cy = q.popleft()
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    np = (cx + dx, cy + dy)
                    if not self.in_bounds(np) or np in blocked or np in outside:
                        continue
                    outside.add(np)
                    q.append(np)

            frontier: set[tuple[int, int]] = set()
            for x, y in comp:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    np = (x + dx, y + dy)
                    if not self.in_bounds(np) or np in blocked:
                        continue
                    frontier.add(np)
            if not frontier or frontier.isdisjoint(outside):
                snuffed.update(comp)
        return snuffed

    def check_winner(self):
        if self.winner is not None:
            return
        for owner, player in enumerate(self.players):
            if player.resigned:
                self.winner = 1 - owner
                self.win_reason = f"{self.owner_name(owner)} resigned."
                return
        for owner in (0, 1):
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
        return True, f"{self.owner_name(self.current_owner)} to move."
