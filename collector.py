#!/usr/bin/env python3
"""Hopscotch collector: one polite poller, many readers.

Modes:
  poll    one collection cycle; writes live.json (+ state) into ./live
  loop    long-run for GitHub Actions: poll every POLL_SECS, push every PUSH_SECS
  daily   build yesterday's summary card from the archive

Data lives on the `data` orphan branch, checked out at ./live in Actions.
"""
import json, os, smtplib, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

from google.transit import gtfs_realtime_pb2 as gtfs

CT = ZoneInfo("America/Chicago")
RT = "https://realtime.ridemcts.com/gtfsrt"
HOP = "https://thehopmke.transloc.com/Services/JSONPRelay.svc"
LIVE = "live"
POLL_SECS = 25
PUSH_SECS = 30
ARCHIVE_EVERY = 15 * 60
GHOST_GRACE_SECS = 12 * 60

def now_ct(): return datetime.now(CT)
def today_key(): return now_ct().strftime("%Y%m%d")

def fetch_bytes(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "hopscotch-collector/1.0"})
    delay = 2
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            retryable = e.code == 429 or 500 <= e.code < 600
            if not retryable or attempt == 3:
                raise
            try:
                delay = max(delay, int(e.headers.get("Retry-After", 0) or 0))
            except (TypeError, ValueError):
                pass
            print(f"fetch {e.code}, backing off {delay}s: {url}", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("fetch_bytes: unreachable")

def fetch_json(url, timeout=20):
    return json.loads(fetch_bytes(url, timeout))

def fetch_feed(name):
    fm = gtfs.FeedMessage()
    fm.ParseFromString(fetch_bytes(f"{RT}/{name}"))
    return fm

def load_json(path, default):
    try:
        with open(path) as f: return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default

def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)

def git(*args, check=True):
    return subprocess.run(["git", "-C", LIVE] + list(args), capture_output=True, text=True, check=check)

# ---------- static data (from main checkout) ----------

_static = None
def load_static():
    global _static
    if _static is None:
        _static = load_json("data/static.json", {})
    st = _static
    routes = {r["id"]: r for r in st.get("routes", [])}
    calendar = st.get("calendar", {})
    stops = {s[0]: s[1:] for s in st.get("stops", [])}
    hop = st.get("hop", {})
    return routes, calendar, stops, hop

def active_services(calendar, datekey):
    return set(calendar.get(datekey, []))

def scheduled_trips_today(calendar, routes):
    """All (trip start seconds, route_id, headsign) for today, from committed timetables."""
    svcs = active_services(calendar, today_key())
    out = []
    for rid in routes:
        safe = rid.replace("/", "_")
        tt = load_json(f"data/timetable/{safe}.json", None)
        if not tt: continue
        for tr in tt.get("trips", []):
            if tr["s"] in svcs and tr["t"]:
                out.append({"route": rid, "start": tr["t"][0],
                            "headsign": tt.get("headsign", {}).get(tr["k"].split(".")[0], "")})
    return out

# ---------- one poll cycle ----------

def plain_alert(entity):
    a = entity.alert
    routes = sorted({ie.route_id for ie in a.informed_entity if ie.route_id})
    def txt(field):
        for t in field.translation:
            if t.language in ("en", ""): return t.text
        return field.translation[0].text if field.translation else ""
    head = txt(a.header_text) if a.HasField("header_text") else ""
    desc = txt(a.description_text) if a.HasField("description_text") else ""
    effect = gtfs.Alert.Effect.Name(a.effect).replace("_", " ").title() if a.effect else "Service Alert"
    # strip stop-id jargon
    import re
    desc = re.sub(r"(Inactive|Active)\s+Stop\s+IDs?\s*[:\-]?\s*[\d,\s]*", "", desc, flags=re.I).strip()
    if len(desc) > 320: desc = desc[:317].rsplit(" ", 1)[0] + "..."
    if not head: head = f"Routes {', '.join(routes)}" if routes else "System alert"
    return {"routes": routes, "effect": effect, "title": head, "text": desc}

def status_line(vehicles, alerts, cfg):
    if not cfg.get("status_line", True): return ""
    big = [a for a in alerts if a["effect"] in ("Detour", "No Service")]
    late = {}
    for v in vehicles:
        if v.get("delay") and v["delay"] >= 600:
            late[v["route"]] = late.get(v["route"], 0) + 1
    worst = max(late.items(), key=lambda kv: kv[1], default=(None, 0))
    if worst[1] >= 3:
        name = worst[0]
        return f"The {name} is having a day"
    if len(big) >= 3:
        return "Detours all over today"
    if sum(late.values()) >= 15:
        return "Rough one out there"
    return "All quiet"

def poll_cycle(state):
    routes, calendar, stops_map, hop_static = load_static()
    ts = int(time.time())

    veh_fm = fetch_feed("vehicles")
    trip_fm = fetch_feed("trips")
    try:
        alert_fm = fetch_feed("alerts")
        alerts = [plain_alert(e) for e in alert_fm.entity]
    except Exception:
        alerts = []

    # trip updates: per-trip delay (vs static schedule) + per-stop predictions
    trip_index = state.get("trip_index", {})
    mid = midnight_epoch(today_key())
    delay_samples = {}
    trip_delay, trip_next, stop_preds, seen_trips = {}, {}, {}, set()
    for e in trip_fm.entity:
        tu = e.trip_update
        tid = tu.trip.trip_id
        seen_trips.add(tid)
        fut = []
        sched = trip_index.get(tid)
        for u in tu.stop_time_update:
            if u.HasField("arrival"):
                at = u.arrival.time
                if sched and u.stop_id in sched["stops"]:
                    si = sched["stops"].index(u.stop_id)
                    delay_samples.setdefault(tid, []).append(at - (mid + sched["t"][si]))
                if at >= ts - 30 and u.stop_id:
                    fut.append((u.stop_id, at))
                    stop_preds.setdefault(u.stop_id, []).append([tu.trip.route_id, at - ts, at, tid])
        fut.sort(key=lambda x: x[1])
        trip_next[tid] = [{"stop": s, "at": a, "in": a - ts,
                           "name": stops_map.get(s, [""])[0]} for s, a in fut[:16]]
    for tid, ds in delay_samples.items():
        ds.sort()
        trip_delay[tid] = ds[len(ds) // 2]
    for sid in stop_preds:
        stop_preds[sid] = sorted(stop_preds[sid], key=lambda x: x[2])[:3]
    supplement_hot_stop_preds(stop_preds, calendar, ts)

    vehicles = []
    for e in veh_fm.entity:
        v = e.vehicle
        if not v.HasField("position"): continue
        tid = v.trip.trip_id
        seen_trips.add(tid)
        vehicles.append({
            "id": v.vehicle.id, "trip": tid, "route": v.trip.route_id,
            "lat": round(v.position.latitude, 6), "lon": round(v.position.longitude, 6),
            "bearing": int(v.position.bearing), "speed": round(v.position.speed, 1),
            "delay": trip_delay.get(tid), "next": trip_next.get(tid, [])[:12],
        })

    # ghost detector
    ghosts = state.get("ghosts", [])
    ghost_keys = {(g["route"], g["sched"]) for g in ghosts}
    secs_now = now_ct().hour * 3600 + now_ct().minute * 60 + now_ct().second
    seen_today = set(state.get("seen", [])) | seen_trips
    # GTFS-RT trip ids match static trip ids, so match precisely:
    job_start = state.get("job_start", 0)
    for item in state.get("sched_ids", []):
        if (item["start"] < secs_now - GHOST_GRACE_SECS and item.get("end", 0) > job_start
                and item["tid"] and item["tid"] not in seen_today):
            key = (item["route"], item["start"])
            if key not in ghost_keys:
                hh = item["start"] // 3600; mm = (item["start"] % 3600) // 60
                ghosts.append({"route": item["route"], "tid": item["tid"],
                               "sched": f"{(hh-1)%12+1}:{mm:02d} {'PM' if hh>=12 else 'AM'}",
                               "headsign": item.get("headsign", "")})
                ghost_keys.add(key)

    # Hop streetcar
    hop_vehicles, hop_stops_out, hop_offline = [], {}, False
    try:
        hv = fetch_json(f"{HOP}/GetMapVehiclePoints?isPublicMap=true")
        for v in hv:
            if not v.get("IsOnRoute"): continue
            hop_vehicles.append({
                "id": v["VehicleID"], "name": v["Name"], "route": v["RouteID"],
                "lat": round(v["Latitude"], 6), "lon": round(v["Longitude"], 6),
                "speed": round(v.get("GroundSpeed") or 0, 1), "heading": v.get("Heading") or 0,
                "delayed": bool(v.get("IsDelayed")),
            })
        try:
            arr = fetch_json(f"{HOP}/GetRouteStopArrivals?isPublicMap=true")
            for s in arr:
                times = [t for t in s.get("ScheduledTimes", [])]
                parsed = []
                for t in times:
                    raw = t.get("ArrivalTimeUTC") or t.get("DepartureTimeUTC") or ""
                    try:
                        at = int(raw.split("(")[1].split(")")[0].split("-")[0].split("+")[0]) // 1000
                    except (IndexError, ValueError):
                        continue
                    if at >= ts - 30: parsed.append(at)
                if parsed:
                    parsed.sort()
                    hop_stops_out[str(s["RouteStopID"])] = [[a - ts, a] for a in parsed[:3]]
        except Exception:
            pass
    except Exception:
        hop_offline = True

    late10 = sum(1 for v in vehicles if v.get("delay") and v["delay"] >= 600)
    cfg = load_json(f"{LIVE}/config.json", {"status_line": True, "sms_enabled": True})
    sms_ready = bool(cfg.get("sms_enabled", True) and os.environ.get("GMAIL_ADDRESS")
                     and os.environ.get("GMAIL_APP_PASSWORD"))
    live = {
        "sms_ready": sms_ready,
        "ts": ts, "status": status_line(vehicles, alerts, cfg),
        "vehicles": vehicles, "hop": hop_vehicles, "hop_offline": hop_offline,
        "stops": stop_preds, "hop_stops": hop_stops_out,
        "alerts": alerts, "ghosts": ghosts[-50:],
        "counts": {"buses": len(vehicles), "hop": len(hop_vehicles), "late10": late10},
    }
    save_json(f"{LIVE}/live.json", live)

    # archive append every ARCHIVE_EVERY
    day = today_key()
    arch_path = f"{LIVE}/archive/{day}.jsonl"
    last_arch = state.get("last_archive", 0)
    if ts - last_arch >= ARCHIVE_EVERY:
        os.makedirs(f"{LIVE}/archive", exist_ok=True)
        with open(arch_path, "a") as f:
            f.write(json.dumps({"ts": ts, "v": [{"r": v["route"], "d": v.get("delay"),
                    "t": v["trip"]} for v in vehicles], "g": len(ghosts),
                    "a": len(alerts)}, separators=(",", ":")) + "\n")
        state["last_archive"] = ts

    # persist state
    state["seen"] = sorted(seen_today)
    state["ghosts"] = ghosts[-200:]
    save_json(f"{LIVE}/state/{day}-state.json", state)

    run_alerts(live, cfg, state, day)
    return live

# ---------- SMS alerts (boats pattern) ----------

def send_sms(to_addr, subject, body):
    addr = os.environ.get("GMAIL_ADDRESS", "")
    pw = os.environ.get("GMAIL_APP_PASSWORD", "")
    if not addr or not pw:
        print("alerts: gmail secrets not set; skipping send")
        return False
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = addr
    msg["To"] = to_addr
    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.starttls(); s.login(addr, pw)
        s.sendmail(addr, [to_addr], msg.as_string())
    return True

def run_alerts(live, cfg, state, day):
    if not cfg.get("sms_enabled", True): return
    watches = load_json(f"{LIVE}/alerts/watches.json", [])
    if not watches: return
    sent = state.setdefault("sent", [])
    def already(k): return k in sent
    def mark(k):
        sent.append(k); state["sent"] = sent[-500:]
        save_json(f"{LIVE}/state/{day}-state.json", state)
    ts = live["ts"]
    for w in watches:
        phone = w.get("phone", "")
        route = w.get("route", "")
        if not phone or not route: continue
        kinds = w.get("kinds", ["delay", "approach", "news"])
        # route delayed beyond threshold
        if "delay" in kinds:
            thr = int(w.get("threshold_min", 8)) * 60
            worst = max((v for v in live["vehicles"] if v["route"] == route and v.get("delay")),
                        key=lambda v: v["delay"], default=None)
            if worst and worst["delay"] >= thr:
                k = f"delay:{route}:{worst['trip']}"
                if not already(k):
                    m = worst["delay"] // 60
                    if send_sms(phone, f"Hopscotch: the {route} is late",
                                f"Route {route} is running about {m} min late right now."):
                        mark(k)
        # watched bus approaching a stop
        if "approach" in kinds and w.get("stop"):
            sid = str(w["stop"])
            for p in live["stops"].get(sid, []):
                if p[0] == route and p[1] <= int(w.get("approach_min", 5)) * 60:
                    k = f"approach:{route}:{sid}:{p[2]}"
                    if not already(k):
                        if send_sms(phone, f"Hopscotch: {route} almost there",
                                    f"The {route} is about {max(1,p[1]//60)} min from your stop."):
                            mark(k)
        # anything new on the route
        if "news" in kinds:
            for a in live["alerts"]:
                if route in a["routes"]:
                    k = f"news:{route}:{a['title']}"
                    if not already(k):
                        if send_sms(phone, f"Hopscotch: {route} alert",
                                    f"{a['effect']} on route {route}: {a['title']}"):
                            mark(k)
            for g in live["ghosts"]:
                if g["route"] == route:
                    k = f"ghost:{route}:{g['sched']}"
                    if not already(k):
                        if send_sms(phone, f"Hopscotch: ghost bus",
                                    f"The {route} scheduled at {g['sched']} never showed."):
                            mark(k)

# ---------- daily summary ----------

def build_daily(day=None):
    day = day or (now_ct() - timedelta(days=1)).strftime("%Y%m%d")
    path = f"{LIVE}/archive/{day}.jsonl"
    rows = []
    try:
        with open(path) as f:
            rows = [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        pass
    trips = set()
    route_delay = {}
    route_samples = {}
    route_ontime = {}
    route_seen_ts = {}
    longest_gap = {}
    for r in rows:
        for v in r.get("v", []):
            trips.add(v.get("t"))
            rid = v.get("r")
            if v.get("d") is not None and rid:
                route_samples[rid] = route_samples.get(rid, 0) + 1
                if v["d"] < 180:  # under three minutes late is useful, human-scale on time
                    route_ontime[rid] = route_ontime.get(rid, 0) + 1
            if v.get("d"):
                route_delay[rid] = max(route_delay.get(rid, 0), v["d"])
            if rid:
                prev = route_seen_ts.get(rid)
                if prev is not None:
                    longest_gap[rid] = max(longest_gap.get(rid, 0), r["ts"] - prev)
                route_seen_ts[rid] = r["ts"]
    worst_delays = sorted(({"route": k, "min": round(v / 60)} for k, v in route_delay.items()),
                          key=lambda x: -x["min"])[:5]
    gaps = sorted(({"route": k, "min": round(v / 60)} for k, v in longest_gap.items()),
                  key=lambda x: -x["min"])[:5]
    reliability = sorted(({
        "route": rid,
        "on_time_pct": round(100 * route_ontime.get(rid, 0) / samples),
        "samples": samples,
    } for rid, samples in route_samples.items()), key=lambda x: x["route"])
    summary = {"date": f"{day[0:4]}-{day[4:6]}-{day[6:8]}", "trips_run": len(trips),
               "worst_delays": worst_delays, "longest_gaps": gaps,
               "worst_routes": [w["route"] for w in worst_delays[:3]],
               "snapshots": len(rows), "reliability": reliability}
    save_json(f"{LIVE}/summary.json", summary)
    return summary

# ---------- git loop ----------

def ensure_data_branch():
    if not os.path.isdir(LIVE):
        fr = subprocess.run(["git", "fetch", "origin", "data"], capture_output=True, text=True)
        if fr.returncode == 0:
            subprocess.run(["git", "branch", "-f", "data", "FETCH_HEAD"], check=True)
            subprocess.run(["git", "worktree", "add", LIVE, "data"], check=True)
            return
        r = subprocess.run(["git", "worktree", "add", LIVE, "data"], capture_output=True, text=True)
        if r.returncode != 0:
            subprocess.run(["git", "checkout", "--orphan", "data"], check=True)
            subprocess.run(["git", "rm", "-rf", "."], capture_output=True)
            os.makedirs(LIVE, exist_ok=True)
            with open(f"{LIVE}/.gitkeep", "w") as f: f.write("")
            subprocess.run(["git", "add", "-A"], check=True)
            subprocess.run(["git", "commit", "-m", "init data branch"], check=True)
            subprocess.run(["git", "push", "-u", "origin", "data"], check=True)
            subprocess.run(["git", "checkout", "main"], check=True)
            subprocess.run(["git", "worktree", "add", LIVE, "data"], check=True)

def push_live():
    for attempt in range(3):
        git("add", "-A")
        r = git("diff", "--staged", "--quiet", check=False)
        if r.returncode == 0: return
        git("commit", "-m", f"live {int(time.time())} [skip ci]")
        git("pull", "--rebase", "origin", "data", check=False)
        p = git("push", "origin", "data", check=False)
        if p.returncode == 0: return
        time.sleep(3)
    print("push failed after retries", file=sys.stderr)



def supplement_hot_stop_preds(stop_preds, calendar, ts):
    """RT feeds only carry in-service trips, so hot-route stops often show one
    departure. Fill the 'one after' from the committed static timetable."""
    hr = load_json("data/hotroutes.json", {})
    legs = [l for r in hr.get("routes", []) for l in r.get("legs", []) if l.get("kind") == "bus"]
    if not legs:
        return
    svcs = active_services(calendar, today_key())
    mid = midnight_epoch(today_key())
    secs_now = ts - mid
    for leg in legs:
        sid = str(leg.get("board") or "")
        if not sid:
            continue
        existing = stop_preds.get(sid, [])
        merged = list(existing)
        for rid in leg.get("routes", []):
            have = [p for p in existing if p[0] == rid]
            need = 2 - len(have)
            if need <= 0:
                continue
            tt = load_timetable_for(rid)
            if not tt:
                continue
            svclist = tt.get("services", [])
            stops_by_key = tt.get("stops", {})
            for tr in tt.get("trips", []):
                tid, si, key, deltas = tr
                if si >= len(svclist) or svclist[si] not in svcs or not deltas:
                    continue
                slist = stops_by_key.get(key, [])
                if sid not in slist:
                    continue
                t = decode_times(deltas)
                at_secs = t[slist.index(sid)]
                if at_secs < secs_now + 60:
                    continue
                at = mid + at_secs
                # skip if an RT prediction for this route sits within 4 min (same trip)
                if any(p[0] == rid and abs(p[2] - at) < 240 for p in merged):
                    continue
                merged.append([rid, at - ts, at, str(tid)])
                need -= 1
                if need <= 0:
                    break
        stop_preds[sid] = sorted(merged, key=lambda x: x[2])[:4]


_tt_cache = {}
def load_timetable_for(rid):
    if rid in _tt_cache: return _tt_cache[rid]
    tindex = load_json("data/static.json", {}).get("tindex", {})
    n = tindex.get(rid)
    if n is None:
        _tt_cache[rid] = None
        return None
    pack = load_json(f"data/tt-{n}.json", {})
    for k, v in pack.items(): _tt_cache[k] = v
    return _tt_cache.get(rid)

def decode_times(deltas):
    out, acc = [], 0
    for d in deltas:
        acc += d
        out.append(acc)
    return out

def scheduled_trips_with_ids(calendar, routes, datekey):
    svcs = active_services(calendar, datekey)
    out = []
    for rid in routes:
        tt = load_timetable_for(rid)
        if not tt: continue
        svclist = tt.get("services", [])
        for tr in tt.get("trips", []):
            tid, si, key, deltas = tr
            if si < len(svclist) and svclist[si] in svcs and deltas:
                t = decode_times(deltas)
                out.append({"tid": str(tid), "route": rid, "start": t[0], "end": t[-1],
                            "headsign": tt.get("headsign", {}).get(key.split(".")[0], "")})
    return out

def today_trip_index(calendar, routes, datekey):
    """tid -> {route, stops:[...], t:[secs...]} for delay computation."""
    svcs = active_services(calendar, datekey)
    idx = {}
    for rid in routes:
        tt = load_timetable_for(rid)
        if not tt: continue
        svclist = tt.get("services", [])
        for tr in tt.get("trips", []):
            tid, si, key, deltas = tr
            if si < len(svclist) and svclist[si] in svcs and deltas:
                idx[str(tid)] = {"route": rid, "stops": tt["stops"][key], "t": decode_times(deltas)}
    return idx

def midnight_epoch(daykey):
    d = datetime(int(daykey[0:4]), int(daykey[4:6]), int(daykey[6:8]), tzinfo=CT)
    return int(d.timestamp())

def load_state():
    day = today_key()
    state = load_json(f"{LIVE}/state/{day}-state.json", {})
    # scheduled trips with ids for ghost detection (rebuilt each job start)
    routes, calendar, _, _ = load_static()
    state["sched_ids"] = scheduled_trips_with_ids(calendar, routes, day)
    state["trip_index"] = today_trip_index(calendar, routes, day)
    n = now_ct()
    state["job_start"] = n.hour * 3600 + n.minute * 60 + n.second
    return state

def loop(minutes):
    ensure_data_branch()
    state = load_state()
    end = time.time() + minutes * 60
    last_push = 0
    last_daily_day = today_key()
    while time.time() < end:
        try:
            poll_cycle(state)
        except Exception as e:
            print(f"poll error: {e}", file=sys.stderr)
        if time.time() - last_push >= PUSH_SECS:
            git("pull", "--rebase", "origin", "data", check=False)
            push_live()
            last_push = time.time()
        if now_ct().hour == 3 and now_ct().minute >= 55 and today_key() != last_daily_day:
            # The date has rolled over; summarize the complete day we just finished.
            try: build_daily((now_ct() - timedelta(days=1)).strftime("%Y%m%d"))
            except Exception as e: print(f"daily error: {e}", file=sys.stderr)
            last_daily_day = today_key()
        time.sleep(POLL_SECS)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "poll"
    if mode == "poll":
        st = load_state() if os.path.isdir(LIVE) else {"seen": [], "ghosts": [], "sched_ids": []}
        if not st.get("sched_ids"):
            routes, calendar, _, _ = load_static()
            st["sched_ids"] = scheduled_trips_with_ids(calendar, routes, today_key())
            st["trip_index"] = today_trip_index(calendar, routes, today_key())
            n = now_ct()
            st["job_start"] = n.hour * 3600 + n.minute * 60 + n.second
        live = poll_cycle(st)
        print(json.dumps({k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in live.items()}, indent=1))
    elif mode == "loop":
        loop(int(sys.argv[2]) if len(sys.argv) > 2 else 355)
    elif mode == "testsms":
        to = os.environ.get("TEST_SMS_TO", "7634432772@tmomail.net")
        ok = send_sms(to, "Hopscotch alerts are live",
                      "Hopscotch text alerts are connected. Watching routes will text this phone when they run late, get close, or make news.")
        print("testsms sent" if ok else "testsms skipped: secrets missing")
    elif mode == "daily":
        print(json.dumps(build_daily(sys.argv[2] if len(sys.argv) > 2 else None), indent=1))
