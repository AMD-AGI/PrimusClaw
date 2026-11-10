# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""Random strings built from every str.splitlines() break, plain characters and nothing, with Python's own result for each:
the corpus pySplitlines (core/src/text/py-text.ts) is checked against. Run: python3 test-support/python/py_splitlines_random.py"""

import json
import random
from pathlib import Path

BREAKS = ["\n", "\r", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]
PLAIN = ["a", "b", " ", "\t", "\x1f", " ", "中", "😀", "\x00"]
PIECES = BREAKS + PLAIN + [""]


def main() -> None:
    rng = random.Random(20261110)
    cases = []
    for _ in range(5000):
        target, text = rng.randint(0, 40), ""
        while len(text) < target:  # (0 to 40 code points; a piece that would pass the target is left out)
            piece = rng.choice(PIECES)
            if len(text) + len(piece) <= target:
                text += piece
        cases.append({"input": text, "lines": text.splitlines()})
    out = Path(__file__).resolve().parent.parent / "data" / "py-splitlines-random.json"
    out.write_text(
        json.dumps({"about": "python3 str.splitlines() of 5000 random strings (seed 20261110), made by "
                    "test-support/python/py_splitlines_random.py", "cases": cases}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
