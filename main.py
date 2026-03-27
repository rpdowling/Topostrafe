from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from store import GameStore
import engine_core as eng
from preset_maps import RULES_TEXT, ALTAR_MAP


BASE_DIR = Path(__file__).resolve().parent
app = FastAPI(title="Topostrafe Web")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
store = GameStore()
connections: dict[str, set[WebSocket]] = defaultdict(set)
conn_lock = asyncio.Lock()


async def broadcast_state(game_id: str, message: str | None = None):
    game = store.get_game(game_id)
    if game is None:
        return
    async with conn_lock:
        sockets = list(connections.get(game_id, set()))
    if not sockets:
        return
    dead = []
    for ws in sockets:
        try:
            player_key = ws.query_params.get("player")
            payload = {"type": "state", "state": store.serialize(game_id, player_key), "message": message}
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    if dead:
        async with conn_lock:
            for ws in dead:
                connections[game_id].discard(ws)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    defaults = store.defaults()
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "defaults_json": json.dumps(defaults),
            "rules_text": RULES_TEXT,
            "title": "Topostrafe",
        },
    )




@app.get("/editor", response_class=HTMLResponse)
async def editor_page(request: Request):
    defaults = store.defaults()
    return templates.TemplateResponse(
        request,
        "editor.html",
        {
            "defaults_json": json.dumps(defaults),
            "title": "Topostrafe Map Editor",
        },
    )


@app.post("/api/generate-map")
async def api_generate_map(payload: dict[str, Any]):
    width = max(5, min(80, int(payload.get("width", 30))))
    height = max(5, min(80, int(payload.get("height", 30))))
    map_type = str(payload.get("map_type", "Noise") or "Noise")
    if map_type == "Altar":
        map_data = eng.MapData(ALTAR_MAP["width"], ALTAR_MAP["height"], [row[:] for row in ALTAR_MAP["grid"]])
    else:
        map_data = eng.MapGenerator.generate(width, height, map_type)
    return JSONResponse({
        "width": map_data.width,
        "height": map_data.height,
        "grid": [row[:] for row in map_data.grid],
    })

@app.get("/game/{game_id}", response_class=HTMLResponse)
async def game_page(request: Request, game_id: str):
    if store.get_game(game_id) is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return templates.TemplateResponse(request, "game.html", {"game_id": game_id, "title": f"Topostrafe {game_id}"})


@app.get("/api/public-games")
async def api_public_games():
    store.prune_expired_open_games()
    return JSONResponse({"games": store.list_public_games()})


@app.get("/api/game/{game_id}/state")
async def api_state(game_id: str, player: str | None = None):
    try:
        return JSONResponse(store.serialize(game_id, player))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/create")
async def api_create(payload: dict[str, Any]):
    store.prune_expired_open_games()
    try:
        created = store.create_game(payload)
        return JSONResponse(created)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/join/public/{game_id}")
async def api_join_public(game_id: str):
    store.prune_expired_open_games()
    try:
        joined = store.join_public(game_id)
        await broadcast_state(game_id, "Opponent joined.")
        return JSONResponse(joined)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/join/private")
async def api_join_private(payload: dict[str, Any]):
    store.prune_expired_open_games()
    try:
        joined = store.join_private(payload.get("join_code", ""))
        await broadcast_state(joined["game_id"], "Opponent joined.")
        return JSONResponse(joined)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.websocket("/ws/game/{game_id}")
async def ws_game(websocket: WebSocket, game_id: str):
    await websocket.accept()
    async with conn_lock:
        connections[game_id].add(websocket)
    player_key = websocket.query_params.get("player")
    store.note_connection_opened(game_id, player_key)
    try:
        await websocket.send_json({"type": "state", "state": store.serialize(game_id, player_key), "message": None})
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type == "ping":
                before = store.serialize(game_id, player_key)
                await websocket.send_json({"type": "state", "state": before, "message": None})
                await broadcast_state(game_id)
                continue
            if msg_type == "chat":
                try:
                    store.add_chat_message(game_id, player_key, data.get("text", ""))
                    await broadcast_state(game_id)
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": str(e)})
                    await websocket.send_json({"type": "state", "state": store.serialize(game_id, player_key), "message": None})
                continue
            try:
                message = store.apply_action(game_id, player_key, data)
                bot_message = store.run_bot_if_needed(game_id)
                merged = message if not bot_message else f"{message} {bot_message}".strip()
                await broadcast_state(game_id, merged)
            except Exception as e:
                await websocket.send_json({"type": "error", "message": str(e)})
                await websocket.send_json({"type": "state", "state": store.serialize(game_id, player_key), "message": None})
    except WebSocketDisconnect:
        pass
    finally:
        async with conn_lock:
            connections[game_id].discard(websocket)
            has_other_connections = bool(connections[game_id])
            if not connections[game_id]:
                connections.pop(game_id, None)
        store.note_connection_closed(game_id, player_key, has_other_connections)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
