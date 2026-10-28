#!/usr/bin/env python3
"""Download the latest U.S. recall data and rebuild public/data/.

Sources (all public, no API keys):
  CPSC  consumer products   https://www.saferproducts.gov/RestWebServices/Recall
  FDA   Class I food        https://api.fda.gov/food/enforcement.json
  NHTSA vehicles and seats  https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip

Run from the repo root:  python3 scripts/build_data.py
Uses only the Python standard library.
"""
import datetime as dt
import io
import json
import os
import re
import shutil
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data")
TODAY = dt.date.today()
PRODUCT_DAYS = 730          # CPSC and FDA recalls from the last two years
SEATS_SINCE = "20160101"    # child seat recalls since this date
CAR_YEARS = (2012, TODAY.year + 1)
MAX_MAKES = 140             # vehicle makes with the most recalls get their own file
ALWAYS_KEEP = {"rivian"}


def get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "SIGI recall builder (github.com)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clip(s, n):
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + "…"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def cpsc():
    start = (TODAY - dt.timedelta(days=PRODUCT_DAYS)).isoformat()
    rows = json.loads(get(f"https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart={start}"))
    out = []
    for r in rows:
        prods = r.get("Products") or []
        haz = [h["Name"] for h in (r.get("Hazards") or []) if h.get("Name") and "None reported" not in h["Name"]]
        title = r.get("Title") or ""
        m = re.search(r"Due to (.+)$", title)
        out.append({
            "id": "C" + str(r["RecallNumber"]), "src": "cpsc", "date": r["RecallDate"][:10],
            "title": clip(title, 200),
            "products": "; ".join(clip(p.get("Name"), 90) for p in prods[:4]),
            "model": clip(" ".join(p.get("Model") or "" for p in prods[:4]), 160),
            "type": (prods[0].get("Type") if prods else "") or "",
            "units": (prods[0].get("NumberOfUnits") if prods else "") or "",
            "hazard": clip(haz[0] if haz else (m.group(1) if m else ""), 200),
            "remedy": clip((r.get("Remedies") or [{}])[0].get("Name", ""), 240),
            "desc": clip(r.get("Description"), 260),
            "sold": clip(" ".join(x["Name"] for x in (r.get("Retailers") or [])[:1]), 140),
            "upc": [u.get("UPC") for u in (r.get("ProductUPCs") or []) if u.get("UPC")][:10],
            "url": r.get("URL") or "",
        })
    return out


def fda():
    start = (TODAY - dt.timedelta(days=365)).strftime("%Y%m%d")
    end = TODAY.strftime("%Y%m%d")
    url = ("https://api.fda.gov/food/enforcement.json?search=report_date:[" + start + "+TO+" + end + "]"
           "+AND+classification:%22Class+I%22&limit=1000")
    rows = json.loads(get(url))["results"]
    out = []
    for r in rows:
        rd = r["report_date"]
        out.append({
            "id": "F" + r["recall_number"], "src": "fda", "date": f"{rd[:4]}-{rd[4:6]}-{rd[6:]}",
            "title": clip(r["recalling_firm"] + ": " + r["product_description"], 200),
            "products": clip(r["product_description"], 200), "model": clip(r.get("code_info", ""), 160),
            "type": "Food", "units": clip(r.get("product_quantity", ""), 40),
            "hazard": clip(r["reason_for_recall"], 200),
            "remedy": "Do not eat. Return to the store or throw it away. Status: " + r["status"] + ".",
            "desc": "", "sold": clip(r.get("distribution_pattern", ""), 140), "upc": [],
            "url": "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
        })
    return out


def nhtsa():
    z = zipfile.ZipFile(io.BytesIO(get("https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip", 900)))
    name = [n for n in z.namelist() if n.upper().endswith(".TXT")][0]
    camps, veh, seats = {}, {}, {}
    with z.open(name) as f:
        for raw in io.TextIOWrapper(f, encoding="latin-1"):
            p = raw.rstrip("\n").split("\t")
            if len(p) < 22:
                continue
            typ, yr, od, cn = p[10], p[4], p[12], p[1]
            if typ == "V":
                try:
                    y = int(yr)
                except ValueError:
                    continue
                if not CAR_YEARS[0] <= y <= CAR_YEARS[1]:
                    continue
            elif typ == "C":
                if od < SEATS_SINCE:
                    continue
            else:
                continue
            if cn not in camps:
                camps[cn] = {"d": f"{od[:4]}-{od[4:6]}-{od[6:8]}", "c": clip(p[6].title(), 60),
                             "s": clip(p[19], 230), "q": clip(p[20], 170), "r": clip(p[21], 150),
                             "n": len(p) > 27 and p[27] == "Y", "o": len(p) > 28 and p[28].strip() == "Y", "u": p[11]}
            if typ == "V":
                veh.setdefault((p[2].strip(), p[3].strip(), yr), set()).add(cn)
            else:
                seats.setdefault(cn, set()).add(f"{p[2].strip()} {p[3].strip()}")
    return camps, veh, seats


def main():
    products = cpsc() + fda()
    camps, veh, seats = nhtsa()
    for cn, names in seats.items():
        c = camps[cn]
        products.append({
            "id": "S" + cn, "src": "seat", "date": c["d"],
            "title": clip("Child seat recall: " + ", ".join(sorted(names)[:4]), 200),
            "products": clip(", ".join(sorted(names)[:8]), 200), "model": "", "type": "Child car seat",
            "units": c["u"], "hazard": c["q"] or c["s"], "remedy": c["r"], "desc": c["s"], "sold": "", "upc": [],
            "url": "https://www.nhtsa.gov/recalls?nhtsaId=" + cn,
        })
    products.sort(key=lambda x: x["date"], reverse=True)

    # group vehicles by make; spellings like "MERCEDES BENZ" and "MERCEDES-BENZ" share a file
    by, names = {}, {}
    for (mk, md, yr), cs in veh.items():
        sl = slug(mk)
        names.setdefault(sl, {}).setdefault(mk, 0)
        names[sl][mk] += 1
        years = by.setdefault(sl, {}).setdefault(md, {})
        years[yr] = sorted(set(years.get(yr, [])) | cs)
    size = {sl: sum(len(y) for y in ms.values()) for sl, ms in by.items()}
    keep = sorted(size, key=size.get, reverse=True)[:MAX_MAKES]
    keep += [k for k in ALWAYS_KEEP if k in by and k not in keep]

    vdir = os.path.join(OUT, "v")
    shutil.rmtree(vdir, ignore_errors=True)
    os.makedirs(vdir)
    makes = {}
    for sl in keep:
        models = by[sl]
        used = {c for m in models.values() for cs in m.values() for c in cs}
        with open(os.path.join(vdir, sl + ".json"), "w") as f:
            json.dump({"models": models, "campaigns": {c: camps[c] for c in used}}, f, separators=(",", ":"))
        makes[max(names[sl], key=names[sl].get)] = {"f": sl, "m": {m: sorted(y) for m, y in models.items()}}

    with open(os.path.join(OUT, "data.json"), "w") as f:
        json.dump({"asOf": TODAY.isoformat(), "products": products, "makes": makes}, f, separators=(",", ":"))
    print(f"{len(products)} product/food/seat recalls, {len(makes)} vehicle makes, as of {TODAY}")


if __name__ == "__main__":
    main()
