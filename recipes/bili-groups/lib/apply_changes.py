#!/usr/bin/env python3
"""Apply {mid: group} corrections. addUsers has replace semantics.

用法:
  python3 apply_changes.py --dry     # 只看计划
  python3 apply_changes.py           # 真正执行
changes.json 格式: {"用户mid": "分组名", ...}
"""
import json
import os
import sys
import time

import bili

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BILI_GROUPS_DATA") or os.path.expanduser("~/.bili-groups/data")  # cccodroid：脚本装在 $PREFIX/lib 下，数据另放
CHANGES = os.path.join(DATA, "changes.json")
CHUNK = 25
SLEEP = 0.9


def main():
    changes = json.load(open(CHANGES))
    dry = "--dry" in sys.argv
    tags = bili.api_get("/x/relation/tags")
    name2id = {t["name"]: t["tagid"] for t in tags}
    by_group = {}
    for mid, g in changes.items():
        by_group.setdefault(g, []).append(str(mid))

    for g, mids in by_group.items():
        if g not in name2id:
            print("[skip-unknown-group] %s: %d" % (g, len(mids)))
            continue
        tagid = name2id[g]
        if dry:
            print("[dry] %s: %d users -> tagid %s" % (g, len(mids), tagid))
            continue
        done = 0
        for i in range(0, len(mids), CHUNK):
            chunk = mids[i:i + CHUNK]
            for attempt in range(4):
                try:
                    bili.api_post("/x/relation/tags/addUsers",
                                  {"fids": ",".join(chunk),
                                   "tagids": str(tagid)})
                    break
                except Exception as e:
                    print("[retry %d] %s @%d %s"
                          % (attempt + 1, g, i, e), flush=True)
                    time.sleep(4 + attempt * 5)
            done += len(chunk)
            print("[set] %s %d/%d" % (g, done, len(mids)), flush=True)
            time.sleep(SLEEP)

    if not dry:
        print("== counts ==")
        for t in bili.api_get("/x/relation/tags"):
            print("%s\t%s\t%s" % (t["tagid"], t["name"], t["count"]))


if __name__ == "__main__":
    main()
