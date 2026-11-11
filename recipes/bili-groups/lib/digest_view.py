#!/usr/bin/env python3
"""Print a compact per-user view of content.json for manual re-bucketing."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BILI_GROUPS_DATA") or os.path.expanduser("~/.bili-groups/data")  # cccodroid：脚本装在 $PREFIX/lib 下，数据另放
sys.path.insert(0, HERE)

content = json.load(open(os.path.join(DATA, "content.json")))["users"]
try:
    tag_names = json.load(open(os.path.join(DATA, "tag_names.json")))
except Exception:
    try:
        import bili
        tag_names = {str(t["tagid"]): t["name"]
                     for t in bili.api_get("/x/relation/tags")}
    except BaseException:
        tag_names = {}

lo = int(sys.argv[1]) if len(sys.argv) > 1 else 0
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(content)

for i, u in enumerate(content[lo:hi], lo):
    tags = u.get("tags") or []
    g = ",".join(tag_names.get(str(t), str(t)) for t in tags) or "-"
    titles = u.get("titles") or []
    txt = " | ".join(t[:38] for t in titles[:6])
    if not txt:
        txt = "【无投稿】" + " / ".join(d[:34] for d in (u.get("dyn") or [])[:4])
    sign = (u.get("sign") or "").replace("\n", " ")[:30]
    print("%3d %s %s [%s] %s"
          % (i, u["mid"], u["uname"][:14], g, txt))
    if not titles and not u.get("dyn"):
        print("      sign: %s" % sign)
