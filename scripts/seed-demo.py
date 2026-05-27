#!/usr/bin/env python3
"""
Populate a running Diluxite instance with synthetic notes for demos and
stress-testing. Idempotent: titles that already exist are skipped, folders
that already exist are reused. The hot-set ("hubs") is deterministic for a
given --seed so the resulting knowledge graph is reproducible.

Usage:
  python3 scripts/seed-demo.py                    # 500 notes, 12 folders
  python3 scripts/seed-demo.py --count 100
  python3 scripts/seed-demo.py --api http://localhost:3030 --seed 42

Requires only the Python standard library. Stdlib `urllib` for HTTP +
`concurrent.futures.ThreadPoolExecutor` for parallelism.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# Vocabulary used to generate titles, folder names and tags. Keeping them in
# one place makes it trivial to swap themes (e.g. en→es) without touching
# the generation logic.

FOLDERS = [
    "Arquitectura",
    "Reglas",
    "Ideas",
    "Decisiones (ADR)",
    "Personas",
    "Proyectos",
    "Tecnologías",
    "Libros",
    "Reuniones",
    "Notas rápidas",
    "Tareas",
    "Bookmarks",
]

TOPICS = [
    # tech
    "API REST", "GraphQL", "WebSockets", "gRPC", "MCP", "Postgres", "pgvector",
    "Redis", "RabbitMQ", "Kafka", "Docker", "Kubernetes", "Helm", "Terraform",
    "Azure OpenAI", "Azure Functions", "Azure App Service", "Azure Front Door",
    "AWS Lambda", "S3", "DynamoDB", "Cloudflare Workers",
    "React", "Vite", "Vue", "Svelte", "Solid", "Tailwind", "shadcn",
    "TypeScript", "Python", "Rust", "Go", "Elixir",
    # concepts
    "Identidad", "Autenticación", "Autorización", "Tokens", "Passkeys", "OAuth",
    "Entra ID", "Single Sign On", "Cifrado", "Compliance", "Auditoría",
    "Observabilidad", "Métricas", "Tracing", "Logging", "Alertas",
    "Performance", "Escalabilidad", "Reliability", "Disaster Recovery",
    "Backup", "Restore", "Migrations", "Schema design", "Índices",
    "Búsqueda semántica", "Búsqueda híbrida", "Reranking", "Embeddings",
    "Chunking", "RRF", "BM25",
    # product
    "Memoria de IA", "Knowledge graph", "Wikilinks", "Backlinks", "Tags",
    "Carpetas", "Workspaces", "Multi-tenant", "Billing", "Pricing",
    "Onboarding", "Activación", "Churn", "Retención",
    # personas
    "Diluxite Cloud", "Diluxite Core", "MVP Application", "MUG", "ConoSurTech",
    "Azure en Español", "Yo Quiero Programar",
    # process
    "Retrospectiva", "Planning", "Daily", "1:1", "Tech talk",
    "Hiring", "Onboarding técnico", "Pair programming",
    # personal
    "Lectura", "Aprendizaje", "Cursos", "Conferencias", "Mentoría",
]

SUFFIXES = [
    "", " — overview", " — deep dive", " — notas", " — draft",
    " v2", " v3", " (decisión)", " (idea)", " (revisión)", " — TODO",
    " — bookmarks", " — referencias",
]

TAGS = [
    "arch", "api", "db", "frontend", "backend", "devops", "security", "ai", "ux",
    "docs", "perf", "scale", "obs", "compliance",
    "idea", "decision", "note", "meeting", "spec", "adr", "todo", "wip",
    "done", "blocked", "review", "draft",
    "typescript", "python", "rust", "go", "postgres", "pgvector",
    "azure", "aws", "docker", "k8s", "react", "vite",
    "mcp", "openai", "entra", "passkey", "billing",
    "memoria", "ia", "graph", "search", "embeddings",
    "personal", "lectura", "curso",
]

INTRO_TEMPLATES = [
    "Resumen breve sobre **{title}**: anotaciones que voy actualizando a medida que aprendo y tomo decisiones.",
    "Notas operativas sobre **{title}**. Acá quedan los aprendizajes, links a otras notas y cosas para chequear con el equipo.",
    "Brain dump sobre **{title}**. Estructurado como referencia, no como tutorial — para tutoriales prefiero linkear afuera.",
    "Documento vivo sobre **{title}**. Punto de partida para futuras decisiones; las relacionadas viven más abajo.",
    "Apuntes sobre **{title}**. Si encontrás algo desactualizado, corrígelo y dejá la nota anterior con tag #archived.",
]

DETAIL_TEMPLATES = [
    "Lo más interesante de {title} es cómo se intersecta con [[{a}]] y [[{b}]] — la frontera entre ambos no es nítida.",
    "Atención: cualquier cambio en {title} afecta a [[{a}]]. Antes de modificar, revisar [[{b}]] y [[{c}]].",
    "Para profundizar: ver [[{a}]] (caso de uso real), [[{b}]] (alternativa que descartamos) y [[{c}]] (referencia externa).",
    "Si volvés a esta nota dentro de 6 meses, lo primero que vas a querer mirar es la evolución de [[{a}]] y la decisión que tomamos en [[{b}]].",
]


def http(method: str, url: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"content-type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} on {method} {url}: {body_text}") from e


def unique_titles(rng: random.Random, count: int, taken: set[str]) -> list[str]:
    """Generate `count` titles that don't collide with `taken`."""
    out: list[str] = []
    while len(out) < count:
        base = rng.choice(TOPICS)
        suffix = rng.choice(SUFFIXES)
        candidate = (base + suffix).strip()
        n = 2
        final = candidate
        while final in taken:
            final = f"{candidate} ({n})"
            n += 1
        taken.add(final)
        out.append(final)
    return out


def generate_content(
    rng: random.Random,
    title: str,
    all_titles: list[str],
    hubs: list[str],
) -> str:
    n_tags = rng.randint(3, 8)
    tags = rng.sample(TAGS, n_tags)

    # 60% of links go to hubs (heavy-tail distribution → some notes will end
    # up with many backlinks, which is what makes the graph interesting),
    # the rest are uniformly random.
    n_links = rng.randint(2, 15)
    links: list[str] = []
    for _ in range(n_links):
        target = rng.choice(hubs) if rng.random() < 0.6 else rng.choice(all_titles)
        if target != title and target not in links:
            links.append(target)

    pick3 = lambda: rng.sample(all_titles, 3)

    intro = rng.choice(INTRO_TEMPLATES).format(title=title)
    a, b, c = pick3()
    detail = rng.choice(DETAIL_TEMPLATES).format(title=title, a=a, b=b, c=c)

    body = (
        f"# {title}\n\n"
        f"{' '.join('#' + t for t in tags)}\n\n"
        f"{intro}\n\n"
        f"## Relacionadas\n\n"
        + "\n".join(f"- [[{l}]]" for l in links) + "\n\n"
        f"## Detalles\n\n{detail}\n"
    )
    return body


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--api", default="http://localhost:3030", help="Base URL of the Diluxite API")
    ap.add_argument("--count", type=int, default=500, help="Notes to add")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed for reproducibility")
    ap.add_argument("--workers", type=int, default=8, help="Concurrent POSTs")
    ap.add_argument("--hub-fraction", type=float, default=0.1, help="Fraction of notes acting as link hubs")
    ap.add_argument("--root-fraction", type=float, default=0.2, help="Fraction of notes left in the space root")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    print(f"→ talking to {args.api}", file=sys.stderr)
    space_id = http("GET", f"{args.api}/api/spaces")[0]["id"]
    existing_notes = http("GET", f"{args.api}/api/spaces/{space_id}/notes")
    existing_titles = {n["title"] for n in existing_notes}
    existing_folders = http("GET", f"{args.api}/api/spaces/{space_id}/folders")
    folder_by_name = {f["name"]: f["id"] for f in existing_folders}

    print(f"  existing: {len(existing_titles)} notes, {len(folder_by_name)} folders", file=sys.stderr)

    # Ensure all folders exist.
    for name in FOLDERS:
        if name not in folder_by_name:
            row = http("POST", f"{args.api}/api/spaces/{space_id}/folders", {"name": name})
            folder_by_name[name] = row["id"]
    folder_ids = list(folder_by_name.values())

    # Plan titles.
    titles = unique_titles(rng, args.count, set(existing_titles))
    all_titles_for_links = list(existing_titles) + titles
    n_hubs = max(1, int(len(titles) * args.hub_fraction))
    hubs = rng.sample(titles, n_hubs)

    print(f"  planning: {len(titles)} new notes, {n_hubs} hubs", file=sys.stderr)

    def create(title: str) -> dict[str, Any]:
        content = generate_content(rng, title, all_titles_for_links, hubs)
        # `rng` is shared across threads; that's fine — we accept slight
        # non-determinism in placement choices for the sake of throughput.
        if rng.random() < args.root_fraction:
            folder_id = None
        else:
            folder_id = rng.choice(folder_ids)
        return http(
            "POST",
            f"{args.api}/api/spaces/{space_id}/notes",
            {"title": title, "contentMd": content, "folderId": folder_id},
        )

    created = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(create, t): t for t in titles}
        for fut in as_completed(futures):
            try:
                fut.result()
                created += 1
                if created % 25 == 0:
                    print(f"  + {created}/{len(titles)}", file=sys.stderr)
            except Exception as e:
                failed += 1
                print(f"  ! {futures[fut]}: {e}", file=sys.stderr)

    print(f"done: {created} created, {failed} failed", file=sys.stderr)

    # Report a few graph stats so the seed is observable.
    final_notes = http("GET", f"{args.api}/api/spaces/{space_id}/notes")
    tags = http("GET", f"{args.api}/api/spaces/{space_id}/tags")
    print(f"  total notes now: {len(final_notes)}", file=sys.stderr)
    print(f"  tags: {len(tags)} unique", file=sys.stderr)
    top_tags = sorted(tags, key=lambda t: -t["count"])[:5]
    print("  top tags: " + ", ".join(f'#{t["tag"]}×{t["count"]}' for t in top_tags), file=sys.stderr)

    # Top hubs by backlink count.
    if hubs:
        print("  sampling backlinks of 5 hubs…", file=sys.stderr)
        sample = rng.sample(hubs, min(5, len(hubs)))
        title_to_id = {n["title"]: n["id"] for n in final_notes}
        for h in sample:
            nid = title_to_id.get(h)
            if not nid:
                continue
            bls = http("GET", f"{args.api}/api/notes/{nid}/backlinks")
            print(f"    «{h}» ← {len(bls)} backlinks", file=sys.stderr)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
