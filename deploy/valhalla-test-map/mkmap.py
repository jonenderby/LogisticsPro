# Builds test.osm.pbf: a tiny road network near Wilmington, DE with a 3.5 m (11'6") bridge
# on the direct road and a longer detour. Used by packages/navigation/test/valhalla.live.test.ts.
# Requires: pip install osmium
import osmium, os
# Small synthetic network near Wilmington, DE.
# Direct road A->B along lat 39.70 has a low bridge (maxheight 3.5 m) in the middle.
# Detour goes north to lat 39.71 and back.
if os.path.exists("test.osm.pbf"): os.remove("test.osm.pbf")
w = osmium.SimpleWriter("test.osm.pbf")
nodes = {}
def node(i, lat, lon):
    nodes[i] = (lat, lon)
lats = 39.70; latn = 39.71
xs = [-75.60 + k * 0.005 for k in range(9)]   # 8 segments of ~430 m
for k, x in enumerate(xs):
    node(100 + k, lats, x)   # south (direct) road
    node(200 + k, latn, x)   # north (detour) road
node(300, 39.705, xs[0]); node(301, 39.705, xs[-1])
for i in sorted(nodes):
    lat, lon = nodes[i]
    w.add_node(osmium.osm.mutable.Node(id=i, location=(lon, lat), version=1, changeset=1, timestamp="2026-01-01T00:00:00Z", uid=1, user="lp"))
def way(i, refs, tags):
    w.add_way(osmium.osm.mutable.Way(id=i, nodes=refs, tags=tags, version=1, changeset=1, timestamp="2026-01-01T00:00:00Z", uid=1, user="lp"))
base = {"highway": "primary", "name": "Direct Road"}
way(1, [100, 101, 102, 103], base)
way(2, [103, 104, 105], {**base, "bridge": "yes", "layer": "1", "maxheight": "3.5", "name": "Low Bridge"})
way(3, [105, 106, 107, 108], base)
way(4, list(range(200, 209)), {"highway": "secondary", "name": "Detour Road"})
way(5, [100, 300, 200], {"highway": "secondary", "name": "West Connector"})
way(6, [108, 301, 208], {"highway": "secondary", "name": "East Connector"})
w.close()
print("wrote", os.path.getsize("test.osm.pbf"), "bytes")
