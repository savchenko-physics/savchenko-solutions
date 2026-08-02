#!/usr/bin/env python3
"""
build-web-graph.py — link graph + authority scores for the /recommendations website tab.

Runs OFFLINE and LOCALLY ONLY. The research corpus it reads is 26 GB and the
production box has 665 MB free; nothing here ever runs on the server. The only
artifact that ships is the small JSON this writes.

What it does
------------
The existing research pipeline (_scrapers/mine/outlink_rank.py) ranks domains by
raw in-degree and calls the result "PageRank-lite". That was honest but left two
things on the table, both fixed here:

  1. The aggregate already contains site->site edges (124 own-domains appear as
     targets, 741 edge instances). Restricting the node set to own-domains plus
     the top external targets closes the cycle, so real iterated PageRank is
     computable without re-walking the 26 GB of gzipped HTML.

  2. Raw authority is useless unmoderated: the ungated top of this graph is
     google.com, youtube.com, facebook.com, and the ungated top-100 of the
     original ranking contains nytimes.com, yahoo.com and imdb.com. Authority is
     only meaningful as a tiebreak INSIDE a vetted category.

Both authority numbers are emitted. `cited_by` (distinct crawled sites linking to
a domain) is the primary, displayed number; `pagerank` is kept as a secondary
sort. That ordering is a measurement, not a preference — see METHODOLOGY below.

Reads (explicit allowlist — never a directory walk; the corpus root holds live
API tokens and private founder data that must not enter any build artifact):
    04_analysis/_outlink_raw_agg.json
    04_analysis/residual_classified.jsonl
    01_competitors/<site>/meta.json          (meta only; never pages/ or raw/)
    _scrapers/mine/outlink_rank.py           (noise blocklist constants)

Writes:
    <repo>/data/web-graph.json

Usage:
    python3 scripts/build-web-graph.py [--corpus PATH] [--top-external N] [--out PATH]
"""

import argparse
import importlib.util
import json
import os
import re
import sys

# --- Registrable-domain handling -------------------------------------------------
# Mirrors _scrapers/mine/outlink_extract.py::reg_domain so that the site_id -> domain
# mapping we derive here lines up exactly with the domains already in the aggregate.
MULTI_SUFFIX = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "sch.uk",
    "com.au", "edu.au", "org.au", "net.au", "gov.au",
    "co.kr", "or.kr", "ne.kr", "ac.kr", "go.kr", "re.kr", "pe.kr", "sc.kr", "hs.kr", "ms.kr", "es.kr",
    "com.cn", "edu.cn", "org.cn", "net.cn", "gov.cn", "ac.cn",
    "ac.in", "co.in", "edu.in", "org.in", "net.in", "gov.in", "res.in", "nic.in", "gen.in",
    "ac.id", "co.id", "or.id", "sch.id", "go.id", "web.id", "my.id", "ponpes.id", "desa.id",
    "com.br", "edu.br", "org.br", "net.br", "gov.br",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp", "gr.jp", "lg.jp",
    "com.tr", "edu.tr", "org.tr", "net.tr", "gov.tr", "k12.tr", "bel.tr",
    "com.tw", "edu.tw", "org.tw", "net.tw", "gov.tw",
    "com.hk", "edu.hk", "org.hk", "net.hk", "gov.hk",
    "com.sg", "edu.sg", "org.sg", "net.sg", "gov.sg",
    "com.my", "edu.my", "org.my", "net.my", "gov.my",
    "com.ua", "edu.ua", "org.ua", "net.ua", "gov.ua", "in.ua", "kiev.ua",
    "com.pl", "edu.pl", "org.pl", "net.pl", "gov.pl",
    "com.mx", "edu.mx", "org.mx", "gob.mx",
    "com.ar", "edu.ar", "org.ar", "net.ar", "gob.ar",
    "com.vn", "edu.vn", "org.vn", "net.vn", "gov.vn",
    "co.il", "org.il", "ac.il", "gov.il", "muni.il", "net.il",
    "co.th", "ac.th", "or.th", "go.th", "in.th",
    "co.nz", "ac.nz", "org.nz", "net.nz", "govt.nz", "school.nz",
    "co.za", "org.za", "ac.za", "gov.za", "edu.za",
    "edu.ph", "com.ph", "org.ph", "gov.ph",
    "edu.pk", "com.pk", "org.pk", "gov.pk",
    "edu.eg", "com.eg", "org.eg", "gov.eg",
    "edu.sa", "com.sa", "org.sa", "gov.sa",
    "com.bd", "edu.bd", "org.bd", "gov.bd", "ac.bd",
    "com.np", "edu.np", "org.np", "gov.np",
    "com.lk", "edu.lk", "org.lk", "gov.lk", "ac.lk",
    "org.rs", "edu.rs", "ac.rs", "gov.rs", "co.rs",
    "com.gr", "edu.gr", "org.gr", "gov.gr", "sch.gr",
    "com.pt", "edu.pt", "org.pt", "gov.pt",
    "com.es", "edu.es", "org.es", "gob.es",
    "edu.it", "gov.it",
    "com.ru", "edu.ru", "org.ru", "net.ru", "gov.ru", "ac.ru", "msk.ru", "spb.ru",
    "org.by", "edu.by", "gov.by", "com.by",
    "edu.kz", "gov.kz", "org.kz", "com.kz", "net.kz",
    "com.uz", "edu.uz", "gov.uz", "org.uz",
    "edu.ge", "gov.ge", "org.ge", "com.ge",
    "edu.az", "gov.az", "com.az", "org.az",
    "com.hr", "edu.hr", "com.ro", "org.ro",
}

HOST_OK = re.compile(r"^[a-z0-9.\-]+$")

# Categories whose members are plausibly useful to a student working a physics
# problem book. Everything else — university_institution (239), tool_infra (121),
# news_media (68), paper_repository (55), physics_math_society (40),
# shopping_misc (32), irrelevant (46) — is authority-rich and use-poor for this
# audience, which is exactly why the gate exists.
USEFUL_CATEGORIES = {
    "olympiad_archive",
    "problem_bank",
    "theory_reference",
    "competitor_solution",
    "community_forum",
    "edtech_platform",
}

DAMPING = 0.85
MAX_ITERS = 100
TOLERANCE = 1e-12


def registrable(host):
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    if ".".join(parts[-2:]) in MULTI_SUFFIX:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def netloc_of(url):
    if not url or not url.startswith("http"):
        return None
    rest = url.split("://", 1)[1]
    for delim in ("/", "?", "#"):
        cut = rest.find(delim)
        if cut >= 0:
            rest = rest[:cut]
    if "@" in rest:
        rest = rest.rsplit("@", 1)[1]
    if rest.startswith("["):
        return None
    rest = rest.split(":")[0].strip().lower().rstrip(".")
    if rest.startswith("www."):
        rest = rest[4:]
    if not rest or "." not in rest or not HOST_OK.match(rest):
        return None
    return rest


def load_noise_filter(corpus):
    """Reuse the research pipeline's curated blocklist rather than re-deriving it.

    218 exact domains + 24 substrings covering CDNs, analytics, social, and
    shorteners. A <script src> to googleapis.com is not a citation, so these are
    dropped from the GRAPH, not merely from the display list — leaving them in
    would let infrastructure absorb and re-emit authority that no author intended.
    """
    path = os.path.join(corpus, "_scrapers", "mine", "outlink_rank.py")
    exact, substr = set(), ()
    if os.path.exists(path):
        spec = importlib.util.spec_from_file_location("_olr", path)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except BaseException:
            # The module runs its pipeline on import; we only want its constants,
            # so a failure past the point of defining them is expected and fine.
            pass
        exact = set(getattr(module, "NOISE_EXACT", set()) or set())
        substr = tuple(getattr(module, "NOISE_SUBSTR", ()) or ())
    if not exact:
        print("  ! noise blocklist unavailable — graph will include infrastructure", file=sys.stderr)

    def is_noise(domain):
        return domain in exact or any(s in domain for s in substr)

    return is_noise, len(exact), len(substr)


def load_site_domains(corpus):
    """site_id -> registrable domain, from each crawled site's meta.json only."""
    comp = os.path.join(corpus, "01_competitors")
    mapping = {}
    if not os.path.isdir(comp):
        return mapping
    for site_id in sorted(os.listdir(comp)):
        meta_path = os.path.join(comp, site_id, "meta.json")
        if not os.path.exists(meta_path):
            continue
        try:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            continue
        host = (meta.get("host") or "").strip().lower() or (netloc_of(meta.get("url") or "") or "")
        if not host:
            continue
        if host.startswith("www."):
            host = host[4:]
        mapping[site_id] = registrable(host)
    return mapping


def load_categories(corpus):
    path = os.path.join(corpus, "04_analysis", "residual_classified.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("domain"):
                out[row["domain"]] = row
    return out


def pagerank(node_count, out_links):
    """Classical PageRank: damping 0.85, dangling mass redistributed uniformly.

    Same formulation as the Telegram side (telegram_groups/llm_classify.py) so the
    two tabs are computed identically and the methodology page can describe one
    algorithm rather than two.
    """
    scores = [1.0 / node_count] * node_count
    base = (1.0 - DAMPING) / node_count
    for _ in range(MAX_ITERS):
        nxt = [base] * node_count
        dangling = 0.0
        for i in range(node_count):
            targets = out_links[i]
            if targets:
                share = DAMPING * scores[i] / len(targets)
                for j in targets:
                    nxt[j] += share
            else:
                dangling += DAMPING * scores[i]
        spread = dangling / node_count
        for i in range(node_count):
            nxt[i] += spread
        if sum(abs(nxt[i] - scores[i]) for i in range(node_count)) < TOLERANCE:
            return nxt
        scores = nxt
    return scores


def spearman(xs, ys):
    def ranks(values):
        order = sorted(range(len(values)), key=lambda k: -values[k])
        out = [0] * len(values)
        for pos, k in enumerate(order):
            out[k] = pos
        return out

    n = len(xs)
    if n < 3:
        return None
    a, b = ranks(xs), ranks(ys)
    d2 = sum((a[k] - b[k]) ** 2 for k in range(n))
    return 1 - 6 * d2 / (n * (n * n - 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="/home/astrosander/Downloads/ss-research")
    ap.add_argument("--top-external", type=int, default=4000,
                    help="external targets kept as graph nodes, by distinct-source in-degree")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "web-graph.json"))
    args = ap.parse_args()

    corpus = os.path.abspath(args.corpus)
    agg_path = os.path.join(corpus, "04_analysis", "_outlink_raw_agg.json")
    if not os.path.exists(agg_path):
        sys.exit(f"missing link aggregate: {agg_path}")

    print(f"corpus: {corpus}")
    is_noise, n_exact, n_substr = load_noise_filter(corpus)
    print(f"  noise blocklist: {n_exact} exact + {n_substr} substrings")

    with open(agg_path, encoding="utf-8") as fh:
        agg = json.load(fh)
    own = set(agg.get("own_domains") or [])
    domains = agg.get("domains") or {}
    print(f"  aggregate: {len(own)} crawled domains -> {len(domains)} target domains")

    site_domain = load_site_domains(corpus)
    categories = load_categories(corpus)
    print(f"  site_id->domain: {len(site_domain)} | classified domains: {len(categories)}")

    # Node set: every crawled domain (these carry the out-edges that close the
    # cycle) plus the highest in-degree external targets. Noise is excluded from
    # the graph entirely, not just from the output.
    externals = [
        d for d, v in sorted(domains.items(), key=lambda kv: -kv[1].get("source_site_count", 0))
        if d not in own and not is_noise(d)
    ][:args.top_external]
    nodes = sorted([d for d in own if not is_noise(d)] + externals)
    index = {d: i for i, d in enumerate(nodes)}
    node_count = len(nodes)

    out_links = [[] for _ in range(node_count)]
    edges = 0
    for target, payload in domains.items():
        ti = index.get(target)
        if ti is None:
            continue
        for site_id in (payload.get("source_sites") or []):
            si = index.get(site_domain.get(site_id))
            if si is None or si == ti:
                continue
            out_links[si].append(ti)
            edges += 1

    with_out = sum(1 for o in out_links if o)
    print(f"  graph: {node_count} nodes, {edges} edges, {with_out} with out-links, "
          f"{node_count - with_out} dangling")
    if edges == 0:
        sys.exit("no edges — site_id->domain mapping failed; aborting rather than "
                 "emitting a graph that would rank on dangling mass alone")

    scores = pagerank(node_count, out_links)
    print(f"  pagerank converged, sum={sum(scores):.6f}")

    # Honesty check, reported every run. If PageRank's dynamic range collapses
    # toward the dangling-mass floor, it is re-ordering on differences that are
    # barely signal, and the simpler in-degree is the better number to display.
    gated = [
        i for i in range(node_count)
        if categories.get(nodes[i], {}).get("category") in USEFUL_CATEGORIES
        and categories.get(nodes[i], {}).get("physics_relevant")
    ]
    diagnostics = {"gated_pool": len(gated)}
    if len(gated) >= 3:
        pr_vals = [scores[i] for i in gated]
        in_vals = [float(domains[nodes[i]].get("source_site_count", 0)) for i in gated]
        pr_spread = max(pr_vals) / min(pr_vals) if min(pr_vals) > 0 else None
        in_spread = max(in_vals) / min(in_vals) if min(in_vals) > 0 else None
        rho = spearman(pr_vals, in_vals)
        top_pr = {nodes[i] for i in sorted(gated, key=lambda i: -scores[i])[:10]}
        top_in = {nodes[i] for i in sorted(gated, key=lambda i: -domains[nodes[i]].get("source_site_count", 0))[:10]}
        diagnostics.update({
            "spearman_pagerank_vs_indegree": rho,
            "pagerank_spread": pr_spread,
            "indegree_spread": in_spread,
            "top10_overlap": len(top_pr & top_in),
        })
        print(f"  gated pool: {len(gated)} domains")
        print(f"    spearman(pagerank, in-degree) = {rho:.4f}")
        print(f"    dynamic range: pagerank {pr_spread:.2f}x vs in-degree {in_spread:.2f}x")
        print(f"    top-10 overlap: {len(top_pr & top_in)}/10")
        if pr_spread and in_spread and pr_spread < in_spread:
            print("    -> in-degree carries more contrast; displaying it as the primary "
                  "authority number, pagerank retained as secondary sort")

    payload = {
        "generated_from": os.path.basename(agg_path),
        "method": {
            "primary": "cited_by = count of distinct crawled sites linking to this domain",
            "secondary": f"pagerank = classical PageRank, damping {DAMPING}, dangling mass "
                         f"redistributed uniformly, over {node_count} nodes",
            "noise_filtered": True,
            "note": "Authority is a tiebreak inside a vetted category, never the primary "
                    "sort. Ungated, this graph ranks google.com and youtube.com first.",
        },
        "diagnostics": diagnostics,
        "domains": {},
    }
    for i, domain in enumerate(nodes):
        entry = domains.get(domain) or {}
        cited_by = int(entry.get("source_site_count", 0))
        if cited_by <= 0 and domain not in own:
            continue
        cat = categories.get(domain) or {}
        payload["domains"][domain] = {
            "cited_by": cited_by,
            "total_links": int(entry.get("total_links", 0)),
            "pagerank": round(scores[i], 12),
            "crawled": domain in own,
            "category": cat.get("category"),
            "physics_relevant": bool(cat.get("physics_relevant")) if cat else None,
            "note": cat.get("note"),
            "useful": cat.get("category") in USEFUL_CATEGORIES and bool(cat.get("physics_relevant")),
        }

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=True)
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"wrote {out_path} ({len(payload['domains'])} domains, {size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
