#!/usr/bin/env python3
"""Extract Russian problem statements and Savchenko's ∗ markers from the printed book.

Run this LOCALLY (it needs poppler's pdftotext, which is not installed on the server) and
commit the JSON it produces. scripts/build-statements.js then reads that file, so the
production build has no binary dependency.

    python3 scripts/extract-pdf-ru.py

Output: src/database/savchenko_ru_pdf.json
    { "1.1.1": { "text": "...", "starred": false }, ... }

Two things to know about the source. Problems appear in two forms — "♦ 5.11.14∗ ." for
ones with a figure and a plain indented "5.11.15." otherwise — and a trailing ∗ is the
author's own marker for a harder problem. The maths comes out of pdftotext as flattened
Unicode ("τy = τx /3"), so `text` here is a faithful transcription, NOT valid LaTeX;
scripts/repair-ru-latex.js is what turns the gap rows into $...$ using the English
statement as a reference.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "pdf", "savchenko.pdf")
OUT = os.path.join(ROOT, "src", "database", "savchenko_ru_pdf.json")

# "♦ 5.11.14∗ ." or "  5.11.15." — the ∗ is the author's harder-problem marker.
#
# The (?<![\d.]) is load-bearing. Without it "11.2.5" also matches as "1.2.5", and a
# magnetostatics problem gets filed under a kinematics number. That is silent corruption:
# the row count still comes out right, so nothing looks wrong until you read the text.
# The trailing period is optional: at least one problem (1.2.5) is printed without it.
# Where it is absent we require the number to open a line and be followed by a capital,
# which is what keeps prose cross-references from matching.
HEADER = re.compile(
    r"(?:♦[ \t]*)?(?<![\d.])(\d{1,2}\.\d{1,2}\.\d{1,3})[ \t]*(∗|\*)?[ \t]*"
    r"(?:\.|(?=[ \t]+[«\u201c\"A-ZА-ЯЁ]))",
    re.M,
)

# The book repeats every problem number in its answers section. Statements only live
# before it, so everything from here on is cut away before parsing.
ANSWERS = re.compile(r"^\s*ОТВЕТЫ\s*$", re.M)


def valid_problems():
    """The authoritative 2,023 problem numbers, from the section maxima."""
    out = []
    path = os.path.join(ROOT, "src", "database", "sections.csv")
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            ref, _title, maximum = line.rsplit(",", 2)
            for i in range(1, int(maximum) + 1):
                out.append(f"{ref}.{i}")
    return out


def main():
    if not os.path.exists(PDF):
        sys.exit(f"missing {PDF}")
    try:
        raw = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", PDF, "-"],
            capture_output=True, check=True,
        ).stdout.decode("utf-8", "replace")
    except FileNotFoundError:
        sys.exit("pdftotext not found — install poppler-utils and run this locally")

    # Cut the answers section away before parsing — the numbers repeat there.
    cut = ANSWERS.search(raw)
    if cut:
        print(f"  answers section starts at {cut.start()} ({cut.start()/len(raw)*100:.1f}%) — truncating")
        raw = raw[:cut.start()]

    expected = valid_problems()
    valid = set(expected)

    # Walk the headers in order. Everything between one header and the next belongs to it.
    # Later hits on a number already seen are cross-references in prose, not a new problem.
    matches = [m for m in HEADER.finditer(raw)]
    found = {}
    for i, m in enumerate(matches):
        num, star = m.group(1), bool(m.group(2))
        if num not in valid or num in found:
            continue
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        body = raw[m.end():end]
        # Strip page furniture: form feeds, and lines that are nothing but page numbers
        # (sometimes two of them, e.g. "15 225", where a running head collides).
        body = body.replace("\x0c", "\n")
        body = re.sub(r"\n[ \t]*\d{1,3}(?:[ \t]+\d{1,3})?[ \t]*\n", "\n", body)
        body = re.sub(r"(\w)-\n(\w)", r"\1\2", body)
        body = re.sub(r"[ \t]+", " ", body)
        body = re.sub(r"\n{2,}", "\n", body).strip()
        found[num] = {"text": body, "starred": star}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(found, fh, ensure_ascii=False, indent=0, sort_keys=True)

    starred = sum(1 for v in found.values() if v["starred"])
    missing = [p for p in expected if p not in found]
    lens = sorted(len(v["text"]) for v in found.values())
    print(f"  problems expected : {len(expected)}")
    print(f"  problems extracted: {len(found)}")
    print(f"  starred (∗)       : {starred}  ({starred / len(found) * 100:.1f}%)")
    print(f"  text length       : min {lens[0]}, median {lens[len(lens) // 2]}, max {lens[-1]}")
    if missing:
        print(f"  MISSING {len(missing)}: {missing[:12]}")
    print(f"  -> {OUT}")


if __name__ == "__main__":
    main()
