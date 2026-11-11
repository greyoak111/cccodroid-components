#!/usr/bin/env python3
"""Fetch recent video titles + current group tags for every following.

先跑 bili.py dump，再跑本脚本。--dyn-only 只抓动态，更轻。
输出 data/content.json 与 data/digest.tsv。
"""
import hashlib
import json
import os
import random
import sys
import time
import urllib.parse
import urllib.request

import bili

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BILI_GROUPS_DATA") or os.path.expanduser("~/.bili-groups/data")  # cccodroid：脚本装在 $PREFIX/lib 下，数据另放
FOLLOWINGS = os.path.join(DATA, "followings.json")
OUT = os.path.join(DATA, "content.json")
DIGEST = os.path.join(DATA, "digest.tsv")

MIX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
       49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24,
       55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
       57, 62, 11, 36, 20, 34, 44, 52]

COOKIES = bili.load_cookies()


def raw_get(path, params=None, signed=False):
    url = bili.API + path
    if params is not None:
        url += "?" + (sign(params) if signed else urllib.parse.urlencode(params))
    obj, _ = bili.request(url, cookies=COOKIES)
    return obj


def refresh_keys():
    obj = raw_get("/x/web-interface/nav")
    w = obj["data"]["wbi_img"]
    ik = w["img_url"].rsplit("/", 1)[1].split(".")[0]
    sk = w["sub_url"].rsplit("/", 1)[1].split(".")[0]
    return "".join((ik + sk)[i] for i in MIX)[:32]


MIXIN = refresh_keys()


def sign(params):
    p = dict(params)
    p["wts"] = int(time.time())
    clean = [(k, "".join(ch for ch in str(v) if ch not in "!'()*"))
             for k, v in sorted(p.items())]
    q = urllib.parse.urlencode(clean)
    return q + "&w_rid=" + hashlib.md5((q + MIXIN).encode()).hexdigest()


def with_retry(fn, label, attempts=5):
    global MIXIN
    for i in range(attempts):
        try:
            obj = fn()
            code = obj.get("code")
            if code == 0:
                return obj.get("data") or {}
            if code in (-352, -799, -412, -509):
                wait = 6 + i * 8
                print("[risk] %s code=%s wait %ss" % (label, code, wait),
                      flush=True)
                time.sleep(wait)
                if i == 2:
                    MIXIN = refresh_keys()
                continue
            return {"_code": code, "_msg": obj.get("message")}
        except Exception as e:
            print("[err] %s %s" % (label, e), flush=True)
            time.sleep(3 + i * 4)
    return {"_err": "exhausted"}


def fetch_user(mid):
    rel = with_retry(lambda: raw_get("/x/relation", {"fid": mid}), "rel%s" % mid)
    vids = with_retry(
        lambda: raw_get("/x/space/wbi/arc/search",
                        {"mid": mid, "ps": 20, "pn": 1, "order": "pubdate"},
                        signed=True), "arc%s" % mid)
    titles, total = [], 0
    if isinstance(vids, dict) and "_code" not in vids and "_err" not in vids:
        vl = (vids.get("list") or {}).get("vlist") or []
        titles = [v.get("title", "") for v in vl][:20]
        total = ((vids.get("page") or {}).get("count") or 0)
    dyn = []
    if not titles:
        d = with_retry(lambda: raw_get(
            "/x/polymer/web-dynamic/v1/feed/space", {"host_mid": mid}),
            "dyn%s" % mid)
        if isinstance(d, dict) and "_code" not in d:
            for it in (d.get("items") or [])[:12]:
                try:
                    mod = it["modules"]["module_dynamic"]
                    txt = ((mod.get("desc") or {}).get("text") or "") \
                        or ((mod.get("major") or {}).get("archive") or {}).get("title") \
                        or ((mod.get("major") or {}).get("opus") or {}).get("title") \
                        or ""
                    if txt:
                        dyn.append(txt.replace("\n", " ")[:100])
                except Exception:
                    pass
    return {
        "mid": str(mid),
        "tags": (rel or {}).get("tag") if isinstance(rel, dict) else None,
        "special": (rel or {}).get("special") if isinstance(rel, dict) else None,
        "uploads": total,
        "titles": titles,
        "dyn": dyn,
    }


def fetch_dyn(mid):
    rel = with_retry(lambda: raw_get("/x/relation", {"fid": mid}), "rel%s" % mid)
    dyn = []
    d = with_retry(lambda: raw_get(
        "/x/polymer/web-dynamic/v1/feed/space", {"host_mid": mid}),
        "dyn%s" % mid)
    if isinstance(d, dict) and "_code" not in d and "_err" not in d:
        for it in (d.get("items") or [])[:20]:
            try:
                mod = it["modules"]["module_dynamic"]
                major = mod.get("major") or {}
                txt = (((mod.get("desc") or {}).get("text") or "")
                       or ((major.get("archive") or {}).get("title") or "")
                       or ((major.get("opus") or {}).get("title") or "")
                       or ((major.get("article") or {}).get("title") or ""))
                if txt:
                    dyn.append(txt.replace("\n", " ")[:100])
            except Exception:
                pass
    return {
        "mid": str(mid),
        "tags": (rel or {}).get("tag") if isinstance(rel, dict) else None,
        "special": (rel or {}).get("special") if isinstance(rel, dict) else None,
        "uploads": 0, "titles": [], "dyn": dyn,
    }


def main():
    dyn_only = "--dyn-only" in sys.argv
    follows = json.load(open(FOLLOWINGS))["list"]
    done = {}
    if os.path.exists(OUT):
        for u in json.load(open(OUT))["users"]:
            done[u["mid"]] = u
    users = []
    t0 = time.time()
    for i, it in enumerate(follows, 1):
        mid = str(it["mid"])
        prev = done.get(mid)
        if prev and prev.get("titles"):
            users.append(prev)
            continue
        if dyn_only:
            if prev and prev.get("dyn") and prev.get("tags") is not None:
                users.append(prev)
                continue
            u = fetch_dyn(mid)
        else:
            if prev and (prev.get("titles") or prev.get("dyn")):
                users.append(prev)
                continue
            u = fetch_user(mid)
        u["uname"] = it.get("uname", "")
        u["sign"] = it.get("sign", "")
        users.append(u)
        print("[%3d/%d] %s %-16s v=%d d=%d tags=%s (%.0fs)"
              % (i, len(follows), mid, u["uname"][:16],
                 len(u["titles"]), len(u["dyn"]), u["tags"],
                 time.time() - t0), flush=True)
        if i % 25 == 0:
            json.dump({"fetched_at": time.time(), "users": users},
                      open(OUT, "w"), ensure_ascii=False)
        time.sleep((1.4 if dyn_only else 0.45) + random.random() * 0.3)
    json.dump({"fetched_at": time.time(), "users": users},
              open(OUT, "w"), ensure_ascii=False)

    tag_names = {t["tagid"]: t["name"]
                 for t in bili.api_get("/x/relation/tags")}
    with open(DIGEST, "w") as f:
        f.write("mid\tuname\t当前分组\t投稿数\tsign\t标题\n")
        for u in users:
            tags = u.get("tags") or []
            g = ",".join(tag_names.get(t, str(t)) for t in tags) or "-"
            titles = " | ".join(u["titles"][:14]) or \
                     " ".join(u["dyn"][:8])
            sign = (u.get("sign") or "").replace("\t", " ").replace("\n", " ")
            uname = (u.get("uname") or "").replace("\t", " ")
            f.write("%s\t%s\t%s\t%s\t%s\t%s\n"
                    % (u["mid"], uname, g, u.get("uploads", 0), sign, titles))
    print("[done]", OUT, DIGEST, flush=True)


if __name__ == "__main__":
    main()
