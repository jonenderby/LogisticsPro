# Valhalla test map

A synthetic road network for checking truck routing against a real Valhalla server without downloading map data.

The direct road between two points crosses a bridge posted at 3.5 m (11'6"). A truck under that height should take the bridge, about 3.3 km. A standard 13'6" trailer should take the detour, about 5.8 km.

```bash
python3 -m venv .venv && .venv/bin/pip install pyvalhalla osmium
.venv/bin/python mkmap.py
.venv/bin/python -m valhalla.valhalla_build_config --mjolnir-tile-dir $PWD/tiles --mjolnir-tile-extract $PWD/tiles.tar > valhalla.json
BIN=$(.venv/bin/python -m valhalla print_bin_path)
$BIN/valhalla_build_tiles -c valhalla.json test.osm.pbf
$BIN/valhalla_service valhalla.json 1 &          # serves on http://localhost:8002

# from the repository root
LP_TEST_VALHALLA_URL=http://localhost:8002 npx vitest run packages/navigation/test/valhalla.live.test.ts
```
