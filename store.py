from __future__ import annotations

import secrets
import string
import threading
import time
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

import engine_core as eng
from preset_maps import ALTAR_MAP, MOSAIC_MAP, PRISON_MAP, RIVER_MAP


ELEVATION_COLORS = {
    1: "#d73027",
    2: "#fc8d59",
    3: "#fee08b",
    4: "#91cf60",
    5: "#4575b4",
}
PLAYER_COLORS = {0: "#ff00ff", 1: "#ffffff"}
PLAYER_OUTLINES = {0: "#2b0030", 1: "#000000"}
MAP_TYPES = ["River", "Prison", "Mosaic", "Three Mountains", "Noise", "Ridges", "Plains", "Mountains", "Altar", "Custom"]
MAP_TYPE_LABELS = {
    "River": "River",
    "Prison": "Prison",
    "Mosaic": "Mosaic",
    "Three Mountains": "Three Mountains (randomized)",
    "Noise": "Noise (randomized)",
    "Ridges": "Ridges (randomized)",
    "Plains": "Plains",
    "Mountains": "Mountains (randomized)",
    "Altar": "Altar",
    "Custom": "Custom",
}
SIZE_PRESETS = {
    "small": {"map_width": 10, "map_height": 10, "max_link_distance": 5, "path_count": 6},
    "medium": {"map_width": 20, "map_height": 20, "max_link_distance": 10, "path_count": 11},
    "large": {"map_width": 30, "map_height": 30, "max_link_distance": 15, "path_count": 16},
}


def _short_id(n: int = 8) -> str:
    return secrets.token_hex(n // 2)


def _token(n: int = 24) -> str:
    return secrets.token_urlsafe(n)[:n]


def _code(n: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


@dataclass
class GameSession:
    game_id: str
    settings: eng.GameSettings
    map_data: eng.MapData
    state: eng.GameState
    is_private: bool
    join_code: str | None
    vs_bot: bool = False
    bot: eng.HeuristicBot | None = None
    status: str = "open"
    created_at: float = field(default_factory=time.time)
    seat_keys: dict[int, str | None] = field(default_factory=lambda: {0: None, 1: None})
    turn_started_at: float | None = None
    time_remaining: dict[int, float] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    chat: list[dict[str, Any]] = field(default_factory=list)
    abandon_delete_at: float | None = None
    pending_premoves: dict[int, dict[str, Any] | None] = field(default_factory=lambda: {0: None, 1: None})

    def __post_init__(self):
        if not self.time_remaining:
            self.time_remaining = {
                0: float(self.settings.time_bank_seconds),
                1: float(self.settings.time_bank_seconds),
            }

    def seat_for_key(self, player_key: str | None) -> int | None:
        if not player_key:
            return None
        for seat, key in self.seat_keys.items():
            if key == player_key:
                return seat
        return None

    def is_full(self) -> bool:
        return self.seat_keys[0] is not None and (self.seat_keys[1] is not None or self.vs_bot)

    def owner_name(self, owner: int) -> str:
        if self.vs_bot and owner == 1:
            return "Bot"
        return eng.PLAYER_NAMES[owner]


class GameStore:

    def __init__(self):
        self.games: dict[str, GameSession] = {}
        self.lock = threading.RLock()

    def defaults(self) -> dict[str, Any]:
        d = eng.GameSettings()
        d.map_type = "River"
        return {
            "settings": d.__dict__.copy(),
            "map_types": MAP_TYPES,
            "map_type_labels": MAP_TYPE_LABELS,
            "elevation_colors": ELEVATION_COLORS,
            "player_colors": PLAYER_COLORS,
        }

    def _prune_expired_open_games_locked(self):
        now = time.time()
        expired = [
            game_id
            for game_id, game in self.games.items()
            if (
                game.status == "open"
                and not game.vs_bot
                and game.seat_keys[1] is None
                and game.abandon_delete_at is not None
                and game.abandon_delete_at <= now
            )
        ]
        for game_id in expired:
            self.games.pop(game_id, None)

    def prune_expired_open_games(self):
        with self.lock:
            self._prune_expired_open_games_locked()

    def note_connection_opened(self, game_id: str, player_key: str | None):
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                return
            if player_key is not None and game.seat_for_key(player_key) is not None:
                game.abandon_delete_at = None

    def note_connection_closed(self, game_id: str, player_key: str | None, same_player_still_connected: bool) -> str | None:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                return None
            if same_player_still_connected:
                return None
            seat = game.seat_for_key(player_key)
            if seat is None:
                return None
            if seat == 0 and game.status == "open" and not game.vs_bot and game.seat_keys[1] is None:
                self.games.pop(game_id, None)
                return None
            if game.status == "active" and game.state.winner is None:
                game.state.players[seat].resigned = True
                game.state.check_winner()
                game.status = "finished"
                msg = f"{game.owner_name(seat)} resigned."
                game.log.append(msg)
                return msg
            return None

    def list_public_games(self) -> list[dict[str, Any]]:
        with self.lock:
            self._prune_expired_open_games_locked()
            rows = []
            for game in self.games.values():
                if game.is_private or game.status != "open":
                    continue
                rows.append(
                    {
                        "game_id": game.game_id,
                        "map_type": game.settings.map_type,
                        "size": f"{game.map_data.width}x{game.map_data.height}",
                        "path_count": game.settings.path_count,
                        "max_link_distance": game.settings.max_link_distance,
                        "time_limit_enabled": game.settings.time_limit_enabled,
                        "time_bank_seconds": game.settings.time_bank_seconds,
                        "created_at": game.created_at,
                    }
                )
            rows.sort(key=lambda x: x["created_at"], reverse=True)
            return rows

    def _settings_from_payload(self, payload: dict[str, Any]) -> eng.GameSettings:
        base = eng.GameSettings()
        preset_name = str(payload.get("size_preset", "")).strip().lower()
        data = {}
        for field in base.__dict__.keys():
            val = payload.get(field, getattr(base, field))
            if isinstance(getattr(base, field), bool):
                data[field] = bool(val)
            elif isinstance(getattr(base, field), int):
                data[field] = int(val)
            else:
                data[field] = val
        if data["map_type"] not in MAP_TYPES:
            data["map_type"] = base.map_type
        if not data["map_type"]:
            data["map_type"] = "River"
        if preset_name in SIZE_PRESETS:
            data.update(SIZE_PRESETS[preset_name])
        data["map_width"] = max(5, min(80, int(data["map_width"])))
        data["map_height"] = max(5, min(80, int(data["map_height"])))
        data["cell_size"] = max(8, min(80, int(data["cell_size"])))
        data["path_count"] = max(1, min(128, int(data["path_count"])))
        data["max_link_distance"] = max(1, min(64, int(data["max_link_distance"])))
        data["start_band"] = max(1, min(8, int(data["start_band"])))
        data["time_bank_seconds"] = max(10, min(24 * 3600, int(data["time_bank_seconds"])))
        return eng.GameSettings(**data)

    def _map_from_payload(self, settings: eng.GameSettings, payload: dict[str, Any]) -> eng.MapData:
        if settings.map_type == "River":
            return eng.MapData(int(RIVER_MAP["width"]), int(RIVER_MAP["height"]), [[int(c) for c in row] for row in RIVER_MAP["grid"]])
        if settings.map_type == "Prison":
            return eng.MapData(int(PRISON_MAP["width"]), int(PRISON_MAP["height"]), [[int(c) for c in row] for row in PRISON_MAP["grid"]])
        if settings.map_type == "Altar":
            return eng.MapData(int(ALTAR_MAP["width"]), int(ALTAR_MAP["height"]), [[int(c) for c in row] for row in ALTAR_MAP["grid"]])
        if settings.map_type == "Mosaic":
            return eng.MapData(int(MOSAIC_MAP["width"]), int(MOSAIC_MAP["height"]), [[int(c) for c in row] for row in MOSAIC_MAP["grid"]])
        if settings.map_type == "Custom":
            raw = payload.get("custom_map_json", "")
            if not raw:
                raise ValueError("Custom map JSON is required when map type is Custom.")
            data = __import__("json").loads(raw)
            width = int(data["width"])
            height = int(data["height"])
            grid = data["grid"]
            if len(grid) != height or any(len(row) != width for row in grid):
                raise ValueError("Custom map grid dimensions do not match width/height.")
            for row in grid:
                for cell in row:
                    if int(cell) not in (1, 2, 3, 4, 5):
                        raise ValueError("Custom map cells must be integers 1..5.")
            return eng.MapData(width, height, [[int(c) for c in row] for row in grid])
        return eng.MapGenerator.generate(settings.map_width, settings.map_height, settings.map_type)

    def create_game(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self._prune_expired_open_games_locked()
            settings_payload = dict(payload.get("settings", {}))
            if "size_preset" in payload and "size_preset" not in settings_payload:
                settings_payload["size_preset"] = payload.get("size_preset")
            settings = self._settings_from_payload(settings_payload)
            map_data = self._map_from_payload(settings, payload)
            game_id = _short_id(8)
            player_key = _token(24)
            is_private = bool(payload.get("is_private", False))
            join_code = (payload.get("join_code") or "").strip().upper() or (_code() if is_private else None)
            vs_bot = bool(payload.get("vs_bot", False))
            state = eng.GameState(settings, map_data.copy())
            game = GameSession(
                game_id=game_id,
                settings=settings,
                map_data=map_data.copy(),
                state=state,
                is_private=is_private,
                join_code=join_code,
                vs_bot=vs_bot,
                bot=eng.HeuristicBot(1) if vs_bot else None,
            )
            game.seat_keys[0] = player_key
            if vs_bot:
                game.seat_keys[1] = "BOT"
                game.status = "active"
                game.abandon_delete_at = None
                game.turn_started_at = time.monotonic()
                game.log.append("Game created vs bot.")
            else:
                game.log.append("Game created. Waiting for opponent.")
            self.games[game_id] = game
            return {
                "game_id": game_id,
                "player_key": player_key,
                "url": f"/game/{game_id}?player={player_key}",
                "join_code": join_code,
            }

    def join_public(self, game_id: str) -> dict[str, Any]:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                raise ValueError("Game not found.")
            if game.is_private:
                raise ValueError("That game is private.")
            if game.status != "open":
                raise ValueError("That game is no longer open.")
            player_key = _token(24)
            game.seat_keys[1] = player_key
            game.status = "active"
            game.abandon_delete_at = None
            game.turn_started_at = time.monotonic()
            game.log.append("Player 2 joined.")
            return {"game_id": game_id, "player_key": player_key, "url": f"/game/{game_id}?player={player_key}"}

    def join_private(self, join_code: str) -> dict[str, Any]:
        join_code = (join_code or "").strip().upper()
        with self.lock:
            self._prune_expired_open_games_locked()
            for game in self.games.values():
                if game.join_code == join_code and game.status == "open":
                    player_key = _token(24)
                    game.seat_keys[1] = player_key
                    game.status = "active"
                    game.abandon_delete_at = None
                    game.turn_started_at = time.monotonic()
                    game.log.append("Private opponent joined.")
                    return {"game_id": game.game_id, "player_key": player_key, "url": f"/game/{game.game_id}?player={player_key}"}
        raise ValueError("No open private game found for that code.")

    def get_game(self, game_id: str) -> GameSession | None:
        with self.lock:
            self._prune_expired_open_games_locked()
            return self.games.get(game_id)

    def _effective_time_remaining(self, game: GameSession, owner: int) -> float:
        remaining = float(game.time_remaining.get(owner, 0.0))
        if (
            game.settings.time_limit_enabled
            and game.turn_started_at is not None
            and owner == game.state.current_owner
            and game.state.winner is None
            and game.status == "active"
        ):
            remaining -= max(0.0, time.monotonic() - game.turn_started_at)
        return max(0.0, remaining)

    def _consume_active_turn_time(self, game: GameSession) -> bool:
        if not game.settings.time_limit_enabled or game.turn_started_at is None or game.state.winner is not None:
            return True
        owner = game.state.current_owner
        game.time_remaining[owner] = self._effective_time_remaining(game, owner)
        game.turn_started_at = time.monotonic()
        if game.time_remaining[owner] <= 0:
            game.state.winner = 1 - owner
            game.state.win_reason = f"{game.owner_name(owner)} ran out of time."
            game.status = "finished"
            game.log.append(game.state.win_reason)
            return False
        return True

    def _check_timeout_passively(self, game: GameSession):
        if not game.settings.time_limit_enabled or game.turn_started_at is None or game.state.winner is not None or game.status != "active":
            return
        owner = game.state.current_owner
        remaining = self._effective_time_remaining(game, owner)
        if remaining <= 0:
            game.time_remaining[owner] = 0.0
            game.state.winner = 1 - owner
            game.state.win_reason = f"{game.owner_name(owner)} ran out of time."
            game.status = "finished"
            game.log.append(game.state.win_reason)

    def serialize(self, game_id: str, player_key: str | None) -> dict[str, Any]:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                raise ValueError("Game not found.")
            self._check_timeout_passively(game)
            seat = game.seat_for_key(player_key)
            state = game.state
            nodes = [
                {"x": x, "y": y, "owner": node.owner, "starter": node.starter}
                for (x, y), node in sorted(state.nodes.items())
            ]
            roads = [
                {"road_id": road.road_id, "owner": road.owner, "path": [[x, y] for (x, y) in road.path]}
                for road in sorted(state.roads.values(), key=lambda r: r.road_id)
            ]
            return {
                "game_id": game.game_id,
                "status": game.status,
                "is_private": game.is_private,
                "join_code": game.join_code if seat == 0 or seat == 1 else None,
                "vs_bot": game.vs_bot,
                "my_seat": seat,
                "my_name": game.owner_name(seat) if seat is not None else "Spectator",
                "current_owner": state.current_owner,
                "current_owner_name": game.owner_name(state.current_owner),
                "winner": state.winner,
                "winner_name": game.owner_name(state.winner) if state.winner is not None else None,
                "win_reason": state.win_reason,
                "remaining_path": state.remaining_path,
                "starter_placed": list(state.starter_placed),
                "time_remaining": {
                    "0": self._effective_time_remaining(game, 0),
                    "1": self._effective_time_remaining(game, 1),
                },
                "settings": game.settings.__dict__.copy(),
                "map": {
                    "width": state.map.width,
                    "height": state.map.height,
                    "grid": [row[:] for row in state.map.grid],
                },
                "nodes": nodes,
                "roads": roads,
                "retake_locks": [{"x": x, "y": y, "blocked_owner": blocked} for (x, y), blocked in state.retake_locks.items()],
                "log": game.log[-16:],
                "chat": game.chat[-100:],
                "my_premove": (seat is not None and game.pending_premoves.get(seat) is not None),
                "my_premove_action": (deepcopy(game.pending_premoves.get(seat)) if seat is not None else None),
            }

    def add_chat_message(self, game_id: str, player_key: str | None, text: str) -> None:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                raise ValueError("Game not found.")
            seat = game.seat_for_key(player_key)
            if seat is None:
                raise ValueError("Only players can chat.")
            msg = str(text or "").strip()
            if not msg:
                return
            if len(msg) > 500:
                msg = msg[:500]
            game.chat.append({"owner": seat, "name": game.owner_name(seat), "text": msg, "ts": time.time()})

    def _assert_player_turn(self, game: GameSession, player_key: str | None) -> int:
        seat = game.seat_for_key(player_key)
        if seat is None:
            raise ValueError("Invalid player key.")
        if game.status != "active":
            raise ValueError("Game is not active yet.")
        if game.state.winner is not None:
            raise ValueError("Game is already finished.")
        if seat != game.state.current_owner:
            raise ValueError("It is not your turn.")
        return seat

    def _start_next_turn(self, game: GameSession):
        game.turn_started_at = time.monotonic() if game.status == "active" else None

    def _normalize_action_payload(self, action: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(action, dict):
            raise ValueError("Invalid action.")
        t = str(action.get("type", "")).strip()
        if t not in {"starter", "routes", "fortify", "entrench", "end_turn", "resign"}:
            raise ValueError("Unknown action.")
        if t == "starter":
            return {"type": "starter", "x": int(action["x"]), "y": int(action["y"])}
        if t == "routes":
            routes = []
            for route in action.get("routes", []):
                routes.append([(int(x), int(y)) for x, y in route])
            return {"type": "routes", "routes": routes}
        if t == "fortify":
            return {"type": "fortify", "x": int(action["x"]), "y": int(action["y"])}
        if t == "entrench":
            src = action["src"]
            target = action["target"]
            return {"type": "entrench", "src": (int(src[0]), int(src[1])), "target": (int(target[0]), int(target[1]))}
        return {"type": t}

    def _execute_turn_action(self, game: GameSession, seat: int, action: dict[str, Any]) -> str:
        t = action.get("type")
        if t == "resign":
            game.state.players[seat].resigned = True
            game.state.check_winner()
            game.status = "finished"
            return f"{game.owner_name(seat)} resigned."

        self._consume_active_turn_time(game)
        if game.state.winner is not None:
            return game.state.win_reason

        auto_end_turn = False
        if t == "starter":
            ok, msg = game.state.commit_starter(int(action["x"]), int(action["y"]))
            auto_end_turn = ok
        elif t == "routes":
            routes = action.get("routes", [])
            ok, msg = game.state.commit_routes(routes)
            auto_end_turn = ok
        elif t == "fortify":
            ok, msg = game.state.commit_fortify((int(action["x"]), int(action["y"])))
            auto_end_turn = ok
        elif t == "entrench":
            src = action["src"]
            target = action["target"]
            ok, msg = game.state.commit_entrench((int(src[0]), int(src[1])), (int(target[0]), int(target[1])))
            auto_end_turn = ok
        elif t == "end_turn":
            ok, msg = game.state.end_turn()
            if ok:
                self._start_next_turn(game)
        else:
            raise ValueError("Unknown action.")

        if not ok:
            raise ValueError(msg)

        if auto_end_turn and game.state.winner is None:
            ok2, msg2 = game.state.end_turn()
            if ok2:
                self._start_next_turn(game)
                msg = f"{msg} {msg2}".strip()

        if game.state.winner is not None:
            game.status = "finished"
        elif t != "end_turn":
            game.turn_started_at = time.monotonic() if game.settings.time_limit_enabled else game.turn_started_at
        return msg

    def _apply_due_premoves(self, game: GameSession) -> list[str]:
        notes: list[str] = []
        loops = 0
        while game.status == "active" and game.state.winner is None and loops < 4:
            seat = game.state.current_owner
            queued = game.pending_premoves.get(seat)
            if not queued:
                break
            game.pending_premoves[seat] = None
            try:
                msg = self._execute_turn_action(game, seat, deepcopy(queued))
                notes.append(f"{game.owner_name(seat)} premove: {msg}")
            except Exception:
                notes.append(f"{game.owner_name(seat)} premove discarded.")
            loops += 1
        return notes

    def apply_action(self, game_id: str, player_key: str | None, action: dict[str, Any]) -> str:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None:
                raise ValueError("Game not found.")
            self._check_timeout_passively(game)
            t = action.get("type")
            seat = game.seat_for_key(player_key)
            if seat is None:
                raise ValueError("Invalid player key.")
            if t == "clear_premove":
                if game.status != "active" or game.state.winner is not None:
                    raise ValueError("Game is not active.")
                if game.pending_premoves.get(seat) is None:
                    return "No premove queued."
                game.pending_premoves[seat] = None
                return "Premove cleared."

            if t == "premove":
                if game.status != "active" or game.state.winner is not None:
                    raise ValueError("Game is not active.")
                if seat == game.state.current_owner:
                    raise ValueError("It is your turn already.")
                queued = self._normalize_action_payload(action.get("action", {}))
                if queued.get("type") == "resign":
                    raise ValueError("Cannot premove resign.")
                game.pending_premoves[seat] = queued
                return "Premove queued."

            if seat != game.state.current_owner and t != "resign":
                raise ValueError("It is not your turn.")
            msg = self._execute_turn_action(game, seat, self._normalize_action_payload(action))
            extra_notes = self._apply_due_premoves(game)
            if extra_notes:
                msg = f"{msg} {' '.join(extra_notes)}".strip()
            game.log.append(msg)
            return msg

    def run_bot_if_needed(self, game_id: str) -> str | None:
        with self.lock:
            self._prune_expired_open_games_locked()
            game = self.games.get(game_id)
            if game is None or not game.vs_bot or game.bot is None:
                return None
            if game.status != "active" or game.state.winner is not None or game.state.current_owner != 1:
                return None
            self._check_timeout_passively(game)
            if game.state.winner is not None:
                return game.state.win_reason
            action = game.bot.choose_action(game.state)
            label = action.get("label", "Bot moved.")
            if action["kind"] == "starter":
                ok, msg = game.state.commit_starter(*action["pos"])
            elif action["kind"] == "routes":
                ok, msg = game.state.commit_routes(action["routes"])
            else:
                ok, msg = True, "Bot passed."
            if not ok:
                msg = label
            self._consume_active_turn_time(game)
            if game.state.winner is None:
                ok2, msg2 = game.state.end_turn()
                if ok2:
                    self._start_next_turn(game)
                    msg = f"{label} {msg2}".strip()
            if game.state.winner is not None:
                game.status = "finished"
            game.log.append(msg)
            return msg
