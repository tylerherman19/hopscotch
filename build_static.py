#!/usr/bin/env python3
"""Build Hopscotch static data files from the MCTS GTFS zip + Hop TransLoc API.
Outputs into ./data/. Run: python3 build_static.py /path/to/google_transit.zip
"""
import csv, json, math, sys, urllib.request, zipfile, os
from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict

GTFS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/gtfs.zip"
OUT = "data"
os.makedirs(OUT, exist_ok=True)

def read_csv(z, name):
    with z.open(name) as f:
        text = (line.decode("utf-8-sig") for line in f)
        yield from csv.DictReader(text)

def hms_to_sec(t):
    if not t: return None
    h, m, s = (int(p) for p in t.split(":"))
    return h * 3600 + m * 60 + s

def douglas_peucker(pts, tol):
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        denom = math.hypot(dx, dy) or 1e-12
        worst, wi = -1, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / denom
            if d > worst: worst, wi = d, i
        if worst > tol:
            keep[wi] = True
            stack += [(a, wi), (wi, b)]
    return [p for p, k in zip(pts, keep) if k]

z = zipfile.ZipFile(GTFS)

# routes
routes = []
for r in read_csv(z, "routes.txt"):
    rid = r["route_id"]
    routes.append({"id": rid, "name": r.get("route_short_name") or rid,
                   "long": (r.get("route_long_name") or "").strip(),
                   "color": r.get("route_color") or "333333"})
def route_key(r):
    n = r["name"]
    return (0, int(n)) if n.isdigit() else (1, n)
routes.sort(key=route_key)
STATIC = {}
STATIC["routes"] = routes
print(f"routes: {len(routes)}")

# stops
stops = {}
for s in read_csv(z, "stops.txt"):
    stops[s["stop_id"]] = [s["stop_name"].strip(), round(float(s["stop_lat"]), 6), round(float(s["stop_lon"]), 6)]
STATIC["stops"] = [[sid] + v for sid, v in sorted(stops.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 10**9)]
print(f"stops: {len(stops)}")

# Expand both regular weekly service and date exceptions; never guess by month.
cal = defaultdict(set)
if "calendar.txt" in z.namelist():
    for c in read_csv(z, "calendar.txt"):
        day = datetime.strptime(c["start_date"], "%Y%m%d")
        end = datetime.strptime(c["end_date"], "%Y%m%d")
        while day <= end:
            if c[day.strftime("%A").lower()] == "1": cal[day.strftime("%Y%m%d")].add(c["service_id"])
            day += timedelta(days=1)
for c in (read_csv(z, "calendar_dates.txt") if "calendar_dates.txt" in z.namelist() else []):
    services = cal[c["date"]]
    if c["exception_type"] == "1": services.add(c["service_id"])
    else: services.discard(c["service_id"])
STATIC["calendar"] = {d: sorted(v) for d, v in sorted(cal.items())}
STATIC["generated_at"] = int(datetime.now(timezone.utc).timestamp())
STATIC["valid_from"] = min(cal) if cal else None
STATIC["valid_until"] = max(cal) if cal else None
print(f"calendar dates: {len(cal)}")

# trips
trips = {}
for t in read_csv(z, "trips.txt"):
    trips[t["trip_id"]] = {"r": t["route_id"], "d": t["direction_id"], "s": t["service_id"],
                           "h": t.get("trip_headsign", ""), "shape": t.get("shape_id", "")}
print(f"trips: {len(trips)}")

# stop_times grouped by trip
st = defaultdict(list)
for row in read_csv(z, "stop_times.txt"):
    tid = row["trip_id"]
    if tid in trips:
        st[tid].append((int(row["stop_sequence"]), row["stop_id"],
                        hms_to_sec(row.get("arrival_time") or row.get("departure_time") or "0:0:0")))
for v in st.values(): v.sort()

# shapes: mode shape per (route,dir)
shape_pts = defaultdict(list)
for row in read_csv(z, "shapes.txt"):
    shape_pts[row["shape_id"]].append((int(float(row["shape_pt_sequence"])),
                                       round(float(row["shape_pt_lat"]), 6), round(float(row["shape_pt_lon"]), 6)))
for v in shape_pts.values(): v.sort()
shape_pts = {k: [(la, lo) for _, la, lo in v] for k, v in shape_pts.items()}

shape_votes = defaultdict(Counter)
for tid, t in trips.items():
    if t["shape"]: shape_votes[(t["r"], t["d"])][t["shape"]] += 1

shapes_out = {}
for (rid, d), votes in shape_votes.items():
    sid = votes.most_common(1)[0][0]
    pts = shape_pts.get(sid, [])
    simp = douglas_peucker(pts, 0.00008)
    if len(simp) > 220:
        simp = douglas_peucker(pts, 0.00015)
    shapes_out.setdefault(rid, {})[d] = simp
STATIC["shapes"] = shapes_out
print(f"shapes: routes={len(shapes_out)}")

# Timetables: retain every branch, short turn and school-day pattern.
by_rd = defaultdict(list)  # (route,dir) -> [trip_id]
for tid, t in trips.items():
    if tid in st: by_rd[(t["r"], t["d"])].append(tid)

per_route = defaultdict(lambda: {"stops": {}, "headsign": {}, "services": [], "trips": [], "trip_headsign": {}})
stop_routes = defaultdict(set)
for (rid, d), tids in by_rd.items():
    patterns = Counter(tuple(sid for _, sid, _ in st[tid]) for tid in tids)
    top = patterns.most_common()
    headsign = Counter(trips[tid]["h"] for tid in tids).most_common(1)[0][0]
    per_route[rid]["headsign"][d] = headsign.title().replace("To ", "To ")
    for vi, (pat, _) in enumerate(top):
        key = f"{d}.{vi}"
        per_route[rid]["stops"][key] = list(pat)
        for sid in pat: stop_routes[sid].add(rid)
        for tid in tids:
            seq = tuple(sid2 for _, sid2, _ in st[tid])
            if seq == pat:
                svc = trips[tid]["s"]
                svcmap = per_route[rid].setdefault("_svcmap", {})
                if svc not in svcmap:
                    svcmap[svc] = len(per_route[rid]["services"])
                    per_route[rid]["services"].append(svc)
                times = [sec for _, _, sec in st[tid]]
                deltas = [times[0]] + [b - a for a, b in zip(times, times[1:])]
                per_route[rid]["trips"].append([str(tid), svcmap[svc], key, deltas])
                per_route[rid]["trip_headsign"][str(tid)] = trips[tid]["h"]

for rid, data in per_route.items():
    data.pop("_svcmap", None)
# Chunk into small balanced packs for mobile connections.
N = 12
chunks = [dict() for _ in range(N)]
sizes = [0] * N
for rid in sorted(per_route, key=lambda r: -len(json.dumps(per_route[r]))):
    blob = json.dumps(per_route[rid])
    i = sizes.index(min(sizes))
    chunks[i][rid] = per_route[rid]
    sizes[i] += len(blob)
for i, c in enumerate(chunks):
    json.dump(c, open(f"{OUT}/tt-{i}.json", "w"), separators=(",", ":"))
STATIC["tindex"] = {rid: i for i, c in enumerate(chunks) for rid in c}
print(f"timetable chunks: {N} for {len(per_route)} routes")

STATIC["stop_routes"] = {k: sorted(v) for k, v in stop_routes.items()}

# Hop streetcar static (TransLoc)
def fetch(url):
    with urllib.request.urlopen(url, timeout=20) as r: return json.load(r)
base = "https://thehopmke.transloc.com/Services/JSONPRelay.svc"
try:
    hops = fetch(f"{base}/GetRoutes?isPublicMap=true")
    hopstops = fetch(f"{base}/GetStops?isPublicMap=true")
    hop = {"routes": [], "stops": [], "lines": {}}
    route_ids_with_stops = {s["RouteID"] for s in hopstops}
    for r in hops:
        if r["RouteID"] in route_ids_with_stops and r.get("IsVisibleOnMap", True):
            hop["routes"].append({"id": r["RouteID"], "name": r["Description"].replace(" THE HOP", ""),
                                  "color": (r.get("MapLineColor") or "#8F7B25").lstrip("#")})
    for rid in [r["id"] for r in hop["routes"]]:
        sline = [s for s in hopstops if s["RouteID"] == rid]
        line = []
        for s in sline:
            hop["stops"].append({"id": s["RouteStopID"], "route": rid, "name": s["Description"],
                                 "lat": round(s["Latitude"], 6), "lon": round(s["Longitude"], 6)})
            pts = [(round(p["Latitude"], 6), round(p["Longitude"], 6)) for p in s.get("MapPoints", [])]
            if pts and line and pts[0] == line[-1]: pts = pts[1:]
            line += pts
        hop["lines"][str(rid)] = line
except Exception as e:
    with open(f"{OUT}/static.json") as previous: hop = json.load(previous).get("hop")
    if not hop: raise
    print(f"Hop static unavailable; retaining previous geometry: {e}")
STATIC["hop"] = hop
print(f"hop: routes={len(hop['routes'])} stops={len(hop['stops'])}")

# static.json is written last, once every section above has been added to
# STATIC. Writing it earlier silently drops stop_routes and hop.
json.dump(STATIC, open(f"{OUT}/static.json", "w"), separators=(",", ":"))
print(f"wrote {OUT}/static.json with sections: {', '.join(STATIC)}")
print("done")
