# Topostrafe Web

Minimal FastAPI/WebSocket web wrapper for the current Topostrafe rules engine.

## Local run

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open `http://127.0.0.1:8000`.

## Files

- `engine_core.py` - extracted game engine from the current desktop script
- `store.py` - in-memory game sessions, public/private join logic, clocks, bot turns
- `main.py` - FastAPI app, templates, WebSocket endpoint
- `templates/` - lobby and game pages
- `static/` - browser UI
- `render.yaml` - Render blueprint

## Notes

- State is stored in memory only. Restarting the service clears open/active games.
- Private games use a join code.
- Public games are listed on the home page until joined.
- Custom maps are raw JSON with `width`, `height`, and `grid`.


## Preset Maps

- `Altar` is bundled as the default preset map.
- The original rules text is shown on the home page.
