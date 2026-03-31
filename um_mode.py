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
        if self.path_lookup.get(pos):
            return False, "Cannot place a node on a path."
        enemy_enclosed = self._enclosed_cells_for_owner(1 - self.current_owner)
        if pos in enemy_enclosed:
            return False, "Cannot place a node inside enemy-encircled territory."
        self.nodes[pos] = UmNode(owner=self.current_owner, starter=False)
        removed = self._resolve_after_action(self.current_owner)
        msg = "Node placed."
        if removed:
            msg = f"{msg} {removed}".strip()
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

    def _enclosed_cells_for_owner(self, owner: int) -> set[tuple[int, int]]:
        blocked = self._owner_wall_cells(owner)
        if not blocked:
            return set()

        open_cells = {(x, y) for x in range(self.width) for y in range(self.height) if (x, y) not in blocked}
        if not open_cells:
            return set()

        corners = {(0, 0), (self.width - 1, 0), (0, self.height - 1), (self.width - 1, self.height - 1)}
        seen: set[tuple[int, int]] = set()
        components: list[tuple[set[tuple[int, int]], bool]] = []

        for start in open_cells:
            if start in seen:
                continue
            comp: set[tuple[int, int]] = set()
            q = deque([start])
            seen.add(start)
            touches_corner = start in corners
            while q:
                x, y = q.popleft()
                comp.add((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    np = (x + dx, y + dy)
                    if np not in open_cells or np in seen:
                        continue
                    seen.add(np)
                    if np in corners:
                        touches_corner = True
                    q.append(np)
            components.append((comp, touches_corner))

        outside: set[tuple[int, int]] = set()
        corner_components = [comp for comp, touches_corner in components if touches_corner]
        if corner_components:
            for comp in corner_components:
                outside.update(comp)
        else:
            max_size = max(len(comp) for comp, _ in components)
            for comp, _ in components:
                if len(comp) == max_size:
                    outside.update(comp)

        return open_cells - outside

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
