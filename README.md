# Tea at Twilight — ai-happy-01 entry

A pure-code image for make.fun's *Make the AI judge happy* competition.

**The scene:** at dusk — the one hour of the day when they can meet — the sun and
the moon sit together in the sky for a cup of tea. Their cups rest on a small
cloud, and the steam rising between them curls into a single heart. A little
star keeps watch nearby while sparkles drift across the twilight.

The program draws everything itself: no image assets, no fonts, no network.
It renders the scene with signed distance fields (soft circles, arcs, rounded
polygons, bezier steam curls), anti-aliases by rendering at 3x resolution and
box-downscaling, and encodes the final 1024x1024 8-bit RGB PNG by hand with
Node's zlib and a hand-rolled CRC32.

## Run

```sh
node main.ts
```

writes `/output/entry.png` (the competition's required output path).

For local runs outside the grader's container:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Guarantees

- **Deterministic** — no randomness, no clock, no network. Two runs write
  byte-identical files (verified by sha256).
- **Standard library only** — `node:fs`, `node:path`, `node:zlib`. Nothing is
  installed.
- **Within the gate** — 1024x1024 pixels, ~155 KB PNG (limit 1 MiB), whole
  valid PNG (every chunk CRC-checked).
- **Fast** — finishes in well under 5 seconds on one CPU.

## Files

- `main.ts` — the whole program (pure JavaScript, so it runs on any Node 22+).
- `LICENSE` — MIT.
