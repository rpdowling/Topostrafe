from __future__ import annotations

from collections import defaultdict, deque
from copy import deepcopy
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
    time_limit_enabled: bool = True
    time_bank_seconds: int = 300


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
        self.starter_edge_placed = [False, False]

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
        self.starter_edge_placed[self.current_owner] = self._is_edge_pos(pos)
        if getattr(self.settings, "infinite_board", False) and all(self.starter_placed):
            if any(self.starter_edge_placed):
                new_w, new_h, _, _ = self._expand_board()
                self.starter_edge_placed = [False, False]
                return True, f"Castle placed. Board expanded to {new_w}x{new_h}."
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

class UmAggressiveBot:
    def __init__(self, owner: int = 1):
        self.owner = int(owner)

    @staticmethod
    def _manhattan(a: tuple[int, int], b: tuple[int, int]) -> int:
        return abs(a[0] - b[0]) + abs(a[1] - b[1])

    def _owner_nodes(self, state: UmGameState, owner: int) -> list[tuple[int, int]]:
        return [pos for pos, node in state.nodes.items() if node.owner == owner]

    def _owner_graph(self, state: UmGameState, owner: int) -> dict[tuple[int, int], set[tuple[int, int]]]:
        graph = {pos: set() for pos, node in state.nodes.items() if node.owner == owner}
        for path in state.paths.values():
            if path.owner != owner or len(path.cells) < 2:
                continue
            a = path.cells[0]
            b = path.cells[-1]
            if a in graph and b in graph:
                graph[a].add(b)
                graph[b].add(a)
        return graph

    def _castle_component(self, state: UmGameState, owner: int) -> set[tuple[int, int]]:
        castle = state.castle_pos(owner)
        if castle is None:
            return set()
        graph = self._owner_graph(state, owner)
        if castle not in graph:
            return {castle}
        seen = {castle}
        q = deque([castle])
        while q:
            cur = q.popleft()
            for nxt in graph.get(cur, ()):
                if nxt in seen:
                    continue
                seen.add(nxt)
                q.append(nxt)
        return seen

    def _footprint_cells(self, state: UmGameState, owner: int) -> set[tuple[int, int]]:
        comp = self._castle_component(state, owner)
        if not comp:
            comp = set(self._owner_nodes(state, owner))
        cells = set(comp)
        for path in state.paths.values():
            if path.owner != owner or len(path.cells) < 2:
                continue
            if path.cells[0] in comp and path.cells[-1] in comp:
                cells.update(path.cells)
        return cells

    def _simple_routes(self, state: UmGameState, start: tuple[int, int], end: tuple[int, int]) -> list[list[tuple[int, int]]]:
        if start == end:
            return []
        routes: list[list[tuple[int, int]]] = []
        if start[0] == end[0] or start[1] == end[1]:
            route = []
            if start[0] == end[0]:
                step = 1 if end[1] >= start[1] else -1
                for y in range(start[1], end[1] + step, step):
                    route.append((start[0], y))
            else:
                step = 1 if end[0] >= start[0] else -1
                for x in range(start[0], end[0] + step, step):
                    route.append((x, start[1]))
            if all(state.in_bounds(cell) for cell in route):
                routes.append(route)
            return routes

        cx1 = (end[0], start[1])
        route1 = []
        step = 1 if end[0] >= start[0] else -1
        for x in range(start[0], end[0] + step, step):
            route1.append((x, start[1]))
        step = 1 if end[1] >= start[1] else -1
        for y in range(start[1] + step, end[1] + step, step):
            route1.append((end[0], y))
        if all(state.in_bounds(cell) for cell in route1):
            routes.append(route1)

        route2 = []
        step = 1 if end[1] >= start[1] else -1
        for y in range(start[1], end[1] + step, step):
            route2.append((start[0], y))
        step = 1 if end[0] >= start[0] else -1
        for x in range(start[0] + step, end[0] + step, step):
            route2.append((x, end[1]))
        if route2 != route1 and all(state.in_bounds(cell) for cell in route2):
            routes.append(route2)
        return routes

    def _potential_path_area(self, state: UmGameState, owner: int) -> set[tuple[int, int]]:
        nodes = self._owner_nodes(state, owner)
        if not nodes:
            return set()
        area = set(nodes)
        nodes = sorted(nodes, key=lambda p: (p[0], p[1]))[:18]
        for i, a in enumerate(nodes):
            for b in nodes[i + 1:]:
                if self._manhattan(a, b) > max(state.width, state.height):
                    continue
                for route in self._simple_routes(state, a, b):
                    area.update(route)
        return area

    def _enemy_node_footprint_area(self, state: UmGameState, owner: int) -> set[tuple[int, int]]:
        area = set(self._potential_path_area(state, owner))
        area.update(self._owner_nodes(state, owner))
        return area

    def _safe_owner_nodes(self, state: UmGameState, owner: int) -> list[tuple[int, int]]:
        if owner != self.owner:
            return self._owner_nodes(state, owner)
        return [pos for pos in self._owner_nodes(state, owner) if not self._enemy_can_cut_node_next(state, pos)]

    def _needs_escape_node(self, state: UmGameState) -> bool:
        owner = self.owner
        enemy = 1 - owner
        own_nodes = self._owner_nodes(state, owner)
        if not own_nodes:
            return False
        enemy_area = self._enemy_node_footprint_area(state, enemy)
        return all(pos in enemy_area for pos in own_nodes)

    def _must_defend(self, state: UmGameState) -> bool:
        owner = self.owner
        enemy = 1 - owner
        if self._needs_escape_node(state):
            return True
        castle = state.castle_pos(owner)
        if castle is None:
            return False
        enemy_walls = state._owner_wall_cells(enemy)
        hostile_adj = 0
        open_adj = 0
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            np = (castle[0] + dx, castle[1] + dy)
            if not state.in_bounds(np):
                continue
            if np in enemy_walls:
                hostile_adj += 1
            else:
                open_adj += 1
        enemy_nodes = self._owner_nodes(state, enemy)
        nearest_enemy = min((self._manhattan(castle, pos) for pos in enemy_nodes), default=99)
        return hostile_adj >= 2 or nearest_enemy <= 3 or open_adj <= 2

    def _enemy_can_cut_node_next(self, state: UmGameState, pos: tuple[int, int]) -> bool:
        enemy = 1 - self.owner
        if pos not in state.nodes:
            return False
        if pos in state._orth_node_surround_kills(enemy):
            return True
        enemy_nodes = self._owner_nodes(state, enemy)
        if len(enemy_nodes) < 2:
            return False
        lim = max(state.width, state.height) + 4
        for i, a in enumerate(enemy_nodes):
            for b in enemy_nodes[i + 1:]:
                if self._manhattan(a, b) > lim:
                    continue
                for route in self._simple_routes(state, a, b):
                    if pos not in set(route[1:-1]):
                        continue
                    sim = deepcopy(state)
                    sim.current_owner = enemy
                    ok, _ = sim.commit_place_paths([route])
                    if ok and pos not in sim.nodes:
                        return True
        return False

    def _count_owner(self, state: UmGameState, owner: int) -> tuple[int, int]:
        node_count = sum(1 for node in state.nodes.values() if node.owner == owner)
        path_count = sum(1 for path in state.paths.values() if path.owner == owner)
        return node_count, path_count

    def _score_state(self, before: UmGameState, after: UmGameState, meta: dict[str, object]) -> int:
        owner = self.owner
        enemy = 1 - owner
        if after.winner == owner:
            return 1_000_000
        if after.winner == enemy:
            return -1_000_000

        before_enemy_nodes, before_enemy_paths = self._count_owner(before, enemy)
        after_enemy_nodes, after_enemy_paths = self._count_owner(after, enemy)
        before_own_nodes, before_own_paths = self._count_owner(before, owner)
        after_own_nodes, after_own_paths = self._count_owner(after, owner)

        removed_enemy_nodes = before_enemy_nodes - after_enemy_nodes
        removed_enemy_paths = before_enemy_paths - after_enemy_paths
        removed_own_nodes = before_own_nodes - after_own_nodes
        removed_own_paths = before_own_paths - after_own_paths

        enemy_castle = after.castle_pos(enemy) or before.castle_pos(enemy)
        enemy_footprint = self._footprint_cells(before, enemy)
        enemy_path_area = self._enemy_node_footprint_area(before, enemy)
        own_castle = after.castle_pos(owner) or before.castle_pos(owner)
        defend = bool(meta.get('defend'))

        score = 0
        score += removed_enemy_nodes * 340 + removed_enemy_paths * 150
        score -= removed_own_nodes * 420 + removed_own_paths * 170

        if meta.get('kind') == 'node':
            pos = meta['pos']
            d_foot = min((self._manhattan(pos, cell) for cell in enemy_footprint), default=12)
            score += max(0, 34 - 8 * d_foot)
            if pos in enemy_path_area:
                score -= 90
            if own_castle is not None and defend:
                score += max(0, 42 - 10 * self._manhattan(pos, own_castle))
            if meta.get('escape'):
                anchor_dist = int(meta.get('anchor_dist', 99))
                if pos in enemy_path_area:
                    score -= 420
                else:
                    score += 240
                score += max(0, 170 - 34 * anchor_dist)
            if self._enemy_can_cut_node_next(after, pos):
                score -= 260
            else:
                score += 70

        if meta.get('kind') == 'path':
            route = meta['segments'][0]
            internal = set(route[1:-1])
            route_len = max(1, len(route) - 1)
            score -= route_len * 4
            if enemy_footprint:
                near = min((min(self._manhattan(cell, fp) for fp in enemy_footprint) for cell in internal), default=12)
                score += max(0, 42 - 7 * near)
            if own_castle is not None and defend:
                near_castle = min((self._manhattan(cell, own_castle) for cell in route), default=12)
                score += max(0, 54 - 11 * near_castle)
            if internal & enemy_path_area:
                score += 55

        if enemy_castle is not None:
            own_nodes_after = self._owner_nodes(after, owner)
            if own_nodes_after:
                score += max(0, 30 - min(self._manhattan(pos, enemy_castle) for pos in own_nodes_after) * 3)
        return score

    def _candidate_cells(self, state: UmGameState, defend: bool) -> list[tuple[int, int]]:
        owner = self.owner
        enemy = 1 - owner
        enemy_footprint = self._footprint_cells(state, enemy)
        enemy_area = self._enemy_node_footprint_area(state, enemy)
        own_castle = state.castle_pos(owner)
        own_nodes = self._owner_nodes(state, owner)
        cells: set[tuple[int, int]] = set()

        seeds = set(enemy_footprint) if enemy_footprint else set(self._owner_nodes(state, enemy))
        for sx, sy in seeds:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    if abs(dx) + abs(dy) > 3:
                        continue
                    pos = (sx + dx, sy + dy)
                    if state.in_bounds(pos):
                        cells.add(pos)
        for sx, sy in own_nodes[:18]:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    if abs(dx) + abs(dy) > 3:
                        continue
                    pos = (sx + dx, sy + dy)
                    if state.in_bounds(pos):
                        cells.add(pos)
        if own_castle is not None:
            for dx in range(-3, 4):
                for dy in range(-3, 4):
                    if abs(dx) + abs(dy) > 4:
                        continue
                    pos = (own_castle[0] + dx, own_castle[1] + dy)
                    if state.in_bounds(pos):
                        cells.add(pos)

        def prescore(pos: tuple[int, int]) -> tuple[int, int, int]:
            d_enemy = min((self._manhattan(pos, cell) for cell in seeds), default=99)
            d_castle = self._manhattan(pos, own_castle) if own_castle is not None else 99
            outside_enemy_area = 0 if pos not in enemy_area else 1
            if defend:
                return (outside_enemy_area, d_castle, d_enemy)
            return (d_enemy, d_castle, outside_enemy_area)

        return sorted(cells, key=prescore)[:50]

    def _generate_escape_node_actions(self, state: UmGameState) -> list[dict[str, object]]:
        owner = self.owner
        enemy = 1 - owner
        enemy_area = self._enemy_node_footprint_area(state, enemy)
        safe_anchors = self._safe_owner_nodes(state, owner)
        if not safe_anchors:
            safe_anchors = self._owner_nodes(state, owner)
        own_castle = state.castle_pos(owner)
        candidate_cells: set[tuple[int, int]] = set()
        for anchor in safe_anchors[:10]:
            for dx in range(-4, 5):
                for dy in range(-4, 5):
                    if abs(dx) + abs(dy) > 5:
                        continue
                    pos = (anchor[0] + dx, anchor[1] + dy)
                    if state.in_bounds(pos):
                        candidate_cells.add(pos)
        for pos in self._candidate_cells(state, defend=True):
            candidate_cells.add(pos)
        if own_castle is not None:
            for dx in range(-5, 6):
                for dy in range(-5, 6):
                    if abs(dx) + abs(dy) > 6:
                        continue
                    pos = (own_castle[0] + dx, own_castle[1] + dy)
                    if state.in_bounds(pos):
                        candidate_cells.add(pos)

        ranked: list[tuple[tuple[int, int, int], tuple[int, int], int]] = []
        for pos in candidate_cells:
            outside = 0 if pos not in enemy_area else 1
            anchor_dist = min((self._manhattan(pos, anchor) for anchor in safe_anchors), default=99)
            enemy_dist = min((self._manhattan(pos, cell) for cell in enemy_area), default=99)
            ranked.append(((outside, anchor_dist, enemy_dist), pos, anchor_dist))
        ranked.sort(key=lambda item: item[0])

        actions: list[dict[str, object]] = []
        for _, pos, anchor_dist in ranked[:70]:
            if pos in enemy_area:
                continue
            sim = deepcopy(state)
            sim.current_owner = owner
            ok, _ = sim.commit_place_node(*pos)
            if not ok:
                continue
            if self._enemy_can_cut_node_next(sim, pos):
                continue
            score = self._score_state(state, sim, {
                'kind': 'node',
                'pos': pos,
                'defend': True,
                'escape': True,
                'anchor_dist': anchor_dist,
            })
            actions.append({
                'score': score,
                'action': {'type': 'um_node', 'x': pos[0], 'y': pos[1], 'label': f'Bot placed a node at {pos[0]},{pos[1]}.'},
            })
        return actions

    def _generate_node_actions(self, state: UmGameState, defend: bool) -> list[dict[str, object]]:
        actions: list[dict[str, object]] = []
        for pos in self._candidate_cells(state, defend):
            sim = deepcopy(state)
            sim.current_owner = self.owner
            ok, _ = sim.commit_place_node(*pos)
            if not ok:
                continue
            score = self._score_state(state, sim, {'kind': 'node', 'pos': pos, 'defend': defend})
            actions.append({
                'score': score,
                'action': {'type': 'um_node', 'x': pos[0], 'y': pos[1], 'label': f'Bot placed a node at {pos[0]},{pos[1]}.'},
            })
        return actions

    def _path_candidate_pairs(self, state: UmGameState, defend: bool) -> list[tuple[tuple[int, int], tuple[int, int]]]:
        owner = self.owner
        enemy = 1 - owner
        own_nodes = self._owner_nodes(state, owner)
        enemy_footprint = self._footprint_cells(state, enemy)
        own_castle = state.castle_pos(owner)
        pairs: list[tuple[tuple[int, int], tuple[int, int], tuple[int, int]]] = []
        for i, a in enumerate(own_nodes):
            for b in own_nodes[i + 1:]:
                if self._manhattan(a, b) < 2:
                    continue
                if self._manhattan(a, b) > max(state.width, state.height) + 2:
                    continue
                metric = min((self._manhattan(a, cell) + self._manhattan(b, cell) for cell in enemy_footprint), default=99)
                if defend and own_castle is not None:
                    metric = min(metric, self._manhattan(a, own_castle) + self._manhattan(b, own_castle))
                pairs.append((metric, a, b))
        pairs.sort(key=lambda item: item[0])
        return [(a, b) for _, a, b in pairs[:40]]

    def _generate_path_actions(self, state: UmGameState, defend: bool) -> list[dict[str, object]]:
        actions: list[dict[str, object]] = []
        for a, b in self._path_candidate_pairs(state, defend):
            for route in self._simple_routes(state, a, b):
                sim = deepcopy(state)
                sim.current_owner = self.owner
                ok, _ = sim.commit_place_paths([route])
                if not ok:
                    continue
                score = self._score_state(state, sim, {'kind': 'path', 'segments': [route], 'defend': defend})
                actions.append({
                    'score': score,
                    'action': {'type': 'um_paths', 'segments': [route], 'label': f'Bot drew a path from {a} to {b}.'},
                })
        return actions

    def _choose_starter(self, state: UmGameState) -> dict[str, object]:
        owner = self.owner
        mid = state.width / 2.0
        candidates = []
        for x in range(state.width):
            for y in range(state.height):
                if owner == 0 and not (x < mid):
                    continue
                if owner == 1 and not (x >= mid):
                    continue
                if (x, y) in state.nodes:
                    continue
                edge_bonus = 0 if state._is_edge_pos((x, y)) else 3
                center_bias = abs(y - state.height / 2.0)
                x_bias = abs(x - (state.width - 1 if owner == 1 else 0))
                candidates.append((edge_bonus + center_bias + x_bias, x, y))
        candidates.sort()
        _, x, y = candidates[0]
        return {'type': 'starter', 'x': int(x), 'y': int(y), 'label': 'Bot placed a castle.'}

    def choose_action(self, state: UmGameState) -> dict[str, object]:
        if not state.has_starter(self.owner):
            return self._choose_starter(state)
        if self._needs_escape_node(state):
            escape_actions = self._generate_escape_node_actions(state)
            if escape_actions:
                escape_actions.sort(key=lambda item: item['score'], reverse=True)
                return escape_actions[0]['action']
        defend = self._must_defend(state)
        actions = self._generate_node_actions(state, defend)
        actions.extend(self._generate_path_actions(state, defend))
        if not actions:
            # Fallback: first legal node placement.
            for x in range(state.width):
                for y in range(state.height):
                    sim = deepcopy(state)
                    sim.current_owner = self.owner
                    ok, _ = sim.commit_place_node(x, y)
                    if ok:
                        return {'type': 'um_node', 'x': int(x), 'y': int(y), 'label': f'Bot placed a node at {x},{y}.'}
            return {'type': 'starter', 'x': 0, 'y': 0, 'label': 'Bot could not move.'}
        actions.sort(key=lambda item: item['score'], reverse=True)
        return actions[0]['action']
