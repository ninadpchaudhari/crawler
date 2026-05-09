# DM vs NL Reachability Crawler

Compares **Direct Manipulation** (click-based, CrawlJax-style) reachability with **Natural Language** (chat-mediated) reachability over a chat-assisted ecommerce app.

## Quick Start

```bash
cd crawler
nvm use 24            # requires Node ≥ 18
npm install
npx playwright install chromium

# Make sure the app is running:
#   docker compose up   (from project root)

node crawl.js                          # headed, depth 2
node crawl.js --headless               # headless
node crawl.js --depth 1                # star graph only (fast, ~1 min)
node crawl.js --depth 2                # two-level BFS (default, ~10 min)
node crawl.js --depth 2 --max-states 50  # cap states to limit runtime
```

## How It Works

### DM Crawl (CrawlJax-style BFS)

Systematically exercises every interactive control at every depth level:

| Depth | What happens | States (typical) |
|-------|-------------|------------------|
| 0 | Baseline (all defaults) | 1 |
| 1 | Change one control from baseline | ~17 |
| 2 | From each depth-1 state, change another control | ~300 |
| 3+ | Continues expanding... | approaches 1,200 max |

**Theoretical max**: 6 categories × 4 prices × 5 ratings × 2 stock × 5 sorts = **1,200 states**

The BFS naturally terminates when no new states are discovered. Use `--max-states N` as a safety valve.

### NL Crawl (Two Phases)

**Phase 1 — Single-shot utterances** (depth 0→1):
Each utterance starts from a clean baseline. Tests how a single NL command maps to GUI state.

**Phase 2 — Refinement chains** (multi-turn, depth 1→2→...):
Sends sequences of utterances *without resetting*, testing conversational memory:

```
Chain: "show electronics" → "now only under $100" → "sort by rating"
Expected: should equal single-shot "show electronics under $100 sorted by rating"
```

This tests whether the NL mediator:
- Maintains context across turns (doesn't reset unrelated controls)
- Handles replacement vs. refinement correctly
- Produces equivalent states via compositional vs. incremental paths

### Metamorphic Relations Tested

| Relation | What it tests | How |
|----------|--------------|-----|
| **MR_SE** | Case insensitivity | Compare `"show electronics..."` vs `"SHOW ELECTRONICS..."` |
| **MR_AC** (chains) | Additive composition | Compare chain result vs single-shot equivalent |

## Outputs

| File | Description |
|------|-------------|
| `coverage_report.json` | Full results: state-flow graphs, transitions, footprints, chain results |
| `dm_graph.dot` | DM state-flow graph in Graphviz DOT format |
| `nl_graph.dot` | NL state-flow graph in Graphviz DOT format |
| `screenshots/` | PNG screenshot of every discovered state |
| `visualizer.html` | Interactive + print-friendly visualization |

### Rendering DOT files

```bash
# Install Graphviz
brew install graphviz   # macOS

# Render to PNG/SVG
dot -Tpng dm_graph.dot -o dm_graph.png
dot -Tsvg dm_graph.dot -o dm_graph.svg

# For large graphs, use sfdp layout:
sfdp -Tpng dm_graph.dot -o dm_graph.png -Goverlap=prism
```

### Visualizer

```bash
npx serve .
# Open http://localhost:3000/visualizer.html
```

**Interactive view**: Force-directed graph with depth-layer filtering, click nodes for screenshots, drag to arrange. Export buttons for DOT/SVG/JSON.

**Print view**: White background, academic-friendly layout. Shows depth 0→1 slice of DM graph (readable), full NL graph, chain results, footprints table, and states-by-depth breakdown. Use `Ctrl+P` → Save as PDF.

## Architecture

```
crawl.js
├── DM Crawl (BFS)
│   ├── depth 0: baseline
│   ├── depth 1: single control changes
│   └── depth 2+: compound control combinations
├── NL Crawl
│   ├── Phase 1: single-shot utterances (reset between each)
│   └── Phase 2: refinement chains (no reset between steps)
├── MR Checks (MR_SE, chain equivalence)
├── DOT Export (Graphviz)
└── JSON Report
```

## Key Metrics

- **|C|**: Total interactive controls (5: category, maxPrice, minRating, inStockOnly, sort)
- **Cov_NL**: `|controls reached via NL| / |C|`
- **States reached**: Unique observable states `O(σ) = {V: control values, D: visible products}`
- **Shared states**: States reachable by both DM and NL
- **Footprint fp(u,σ)**: Controls changed by a single NL utterance
