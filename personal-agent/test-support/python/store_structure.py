# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""The structure of a store database, as JSON: what both workers must agree on byte for byte.

    python3 store_structure.py <db path>

Every `sqlite_master` row (its SQL as SQLite keeps it, so the order of added columns counts), and per table its
`PRAGMA table_info` and `PRAGMA index_list`. The TypeScript side computes the same (test-support/store-structure.ts).
"""

import json
import sqlite3
import sys


def structure(path):
    db = sqlite3.connect(path)
    try:
        master = [
            {"type": t, "name": n, "tbl_name": tn, "sql": s}
            for t, n, tn, s in db.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
            )
        ]
        tables = {}
        for row in master:
            if row["type"] != "table":
                continue
            name = row["name"]
            tables[name] = {
                "columns": [
                    {"cid": c, "name": n, "type": t, "notnull": nn, "dflt_value": d, "pk": pk}
                    for c, n, t, nn, d, pk in db.execute(f"PRAGMA table_info({name})")
                ],
                "indexes": [
                    {"seq": s, "name": n, "unique": u, "origin": o, "partial": p}
                    for s, n, u, o, p in db.execute(f"PRAGMA index_list({name})")
                ],
            }
        return {"master": master, "tables": tables}
    finally:
        db.close()


if __name__ == "__main__":
    json.dump(structure(sys.argv[1]), sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")
