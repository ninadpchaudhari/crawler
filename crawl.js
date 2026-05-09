const { chromium } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_URL = "http://localhost:5173/";
const SETTLE_MS = 1500;
const LLM_TIMEOUT_MS = 20000;
const HEADLESS = process.argv.includes("--headless");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

function parseArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : fallback;
}
const MAX_DEPTH = parseArg("--depth", 2);
const MAX_STATES = parseArg("--max-states", 0); // 0 = unlimited

// ─── Controls definition ─────────────────────────────────────────────────────
const CONTROLS = [
  { name: "category", type: "select", selector: ".sidebar .field-label:nth-of-type(1) select",
    values: ["", "electronics", "books", "clothing", "home", "sports"] },
  { name: "maxPrice", type: "input", selector: '.sidebar input[type="number"]',
    values: ["50", "100", "200", "500"] },
  { name: "minRating", type: "select", selector: ".sidebar .field-label:nth-of-type(3) select",
    values: ["", "3", "3.5", "4", "4.5"] },
  { name: "inStockOnly", type: "checkbox", selector: '.checkbox-label input[type="checkbox"]',
    values: [true, false] },
  { name: "sort", type: "select", selector: ".sidebar .field-label:nth-of-type(5) select",
    values: ["", "price_asc", "price_desc", "rating_desc", "name_asc"] },
];

const DEFAULTS = { category: "", maxPrice: "500", minRating: "", inStockOnly: false, sort: "" };

// ─── NL utterances — single-shot (depth 0→1) ────────────────────────────────
const NL_UTTERANCES = [
  { id: "nl_base",     text: "show electronics under $100 sorted by rating" },
  { id: "nl_caps",     text: "SHOW ELECTRONICS UNDER $100 SORTED BY RATING" },
  { id: "nl_refine",   text: "show electronics under $100 with rating above 4" },
  { id: "nl_all",      text: "show all products" },
  { id: "nl_clothing", text: "show clothing items" },
  { id: "nl_under50",  text: "show items under $50" },
  { id: "nl_sort",     text: "sort by price low to high" },
  { id: "nl_instock",  text: "show in stock items only" },
];

// ─── NL refinement chains (depth 1→2) ───────────────────────────────────────
// Each chain: sequence of utterances sent WITHOUT resetting in between.
// The final state of chain should equal the equivalent single compositional utterance.
const NL_CHAINS = [
  {
    id: "chain_electronics_price_sort",
    steps: [
      "show electronics",
      "now only under $100",
      "sort by rating high to low",
    ],
    equivalent: "show electronics under $100 sorted by rating",
    description: "Incremental 3-step refinement → should equal single compositional utterance",
  },
  {
    id: "chain_clothing_instock",
    steps: [
      "show clothing items",
      "only show in stock",
    ],
    equivalent: null, // no single-shot equivalent, just testing multi-turn
    description: "Two-step category + stock filter refinement",
  },
  {
    id: "chain_price_then_rating",
    steps: [
      "show items under $50",
      "also only show items rated 4 or above",
    ],
    equivalent: null,
    description: "Price filter then rating refinement — tests context carry-over",
  },
  {
    id: "chain_replace_vs_refine",
    steps: [
      "show electronics",
      "show clothing items", // REPLACEMENT, not refinement
    ],
    equivalent: "show clothing items",
    description: "Does a new category command replace or stack? Should replace.",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashState(state) {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
}

async function captureState(page) {
  const V = {};
  V.category = await page.$eval(".sidebar .field-label:nth-of-type(1) select", el => el.value);
  V.maxPrice = await page.$eval('.sidebar input[type="number"]', el => el.value);
  V.minRating = await page.$eval(".sidebar .field-label:nth-of-type(3) select", el => el.value);
  V.inStockOnly = await page.$eval('.checkbox-label input[type="checkbox"]', el => el.checked);
  V.sort = await page.$eval(".sidebar .field-label:nth-of-type(5) select", el => el.value);
  const D = await page.$$eval(".card-name", els => els.map(e => e.textContent.trim()).sort());
  return { V, D };
}

async function takeScreenshot(page, hash) {
  const filePath = path.join(SCREENSHOTS_DIR, `${hash}.png`);
  if (!fs.existsSync(filePath)) {
    await page.screenshot({ path: filePath, fullPage: false });
  }
  return `screenshots/${hash}.png`;
}

async function resetFilters(page) {
  await page.click(".clear-btn");
  await sleep(SETTLE_MS);
}

async function setControl(page, control, value) {
  if (control.type === "select") {
    await page.selectOption(control.selector, value);
  } else if (control.type === "input") {
    await page.fill(control.selector, String(value));
    await page.press(control.selector, "Tab");
  } else if (control.type === "checkbox") {
    const checked = await page.$eval(control.selector, el => el.checked);
    if (checked !== value) await page.click(control.selector);
  }
  await sleep(SETTLE_MS);
}

async function applyState(page, controlValues) {
  await resetFilters(page);
  for (const control of CONTROLS) {
    const target = controlValues[control.name];
    if (target === undefined) continue;
    if (String(target) === String(DEFAULTS[control.name])) continue;
    await setControl(page, control, target);
  }
}

function addState(stateMap, state, screenshotPath, depth) {
  const h = hashState(state);
  if (!stateMap.has(h)) {
    stateMap.set(h, { ...state, screenshot: screenshotPath || null, depth: depth ?? 0 });
  }
  return h;
}

// ─── DM Crawl — BFS with depth + state cap ──────────────────────────────────
async function dmCrawl(page) {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║  DM CRAWL  depth=${MAX_DEPTH}  max-states=${MAX_STATES || '∞'}       ║`);
  console.log("╚══════════════════════════════════════════════╝\n");

  const stateMap = new Map();
  const transitions = [];
  const controlsExercised = new Set();

  await resetFilters(page);
  const baseState = await captureState(page);
  const baseScreenshot = await takeScreenshot(page, hashState(baseState));
  const baseHash = addState(stateMap, baseState, baseScreenshot, 0);
  console.log(`  Baseline: ${baseHash} (${baseState.D.length} products)\n`);

  const queue = [{ hash: baseHash, controlValues: baseState.V, depth: 0 }];
  const explored = new Set([baseHash]);
  let actionCount = 0;
  let hitCap = false;

  while (queue.length > 0) {
    if (MAX_STATES > 0 && stateMap.size >= MAX_STATES) {
      console.log(`  ⚠ State cap reached (${MAX_STATES}). Stopping BFS.\n`);
      hitCap = true;
      break;
    }

    const { hash: fromHash, controlValues: fromV, depth } = queue.shift();
    if (depth >= MAX_DEPTH) continue;

    console.log(`  ── ${fromHash} (depth ${depth}, queue ${queue.length}) ──`);

    for (const control of CONTROLS) {
      if (hitCap) break;
      for (const value of control.values) {
        if (MAX_STATES > 0 && stateMap.size >= MAX_STATES) { hitCap = true; break; }
        const currentVal = fromV[control.name];
        if (String(currentVal) === String(value)) continue;

        actionCount++;
        const label = `${control.name}=${JSON.stringify(value)}`;
        process.stdout.write(`    [${actionCount}] ${label} ... `);

        await applyState(page, fromV);
        await setControl(page, control, value);

        const state = await captureState(page);
        const h = hashState(state);
        const isNew = !stateMap.has(h);
        const screenshot = await takeScreenshot(page, h);
        addState(stateMap, state, screenshot, depth + 1);
        transitions.push({ from: fromHash, action: label, to: h });
        controlsExercised.add(control.name);
        console.log(`→ ${h}  [${state.D.length}p]${isNew ? " NEW" : ""}`);

        if (isNew && !explored.has(h)) {
          explored.add(h);
          queue.push({ hash: h, controlValues: state.V, depth: depth + 1 });
        }
      }
    }
    console.log();
  }

  console.log(`  DM complete: ${stateMap.size} states, ${transitions.length} transitions, ${actionCount} actions\n`);
  return { stateMap, transitions, controlsExercised, baseHash };
}

// ─── NL helpers ──────────────────────────────────────────────────────────────
async function sendChat(page, text) {
  const beforeCount = await page.$$eval(".chat-msg-assistant", els => els.length);
  await page.fill(".chat-textarea", text);
  await page.click(".chat-send-btn");
  try {
    await page.waitForFunction(
      expected => document.querySelectorAll(".chat-msg-assistant").length > expected,
      beforeCount,
      { timeout: LLM_TIMEOUT_MS }
    );
  } catch { console.log("    ⚠ Timeout waiting for response"); }
  await sleep(SETTLE_MS);
}

function computeFootprint(pre, post) {
  const fp = [];
  for (const key of Object.keys(post.V)) {
    if (String(pre.V[key]) !== String(post.V[key])) fp.push(key);
  }
  return fp;
}

// ─── NL Crawl (single-shot + refinement chains) ─────────────────────────────
async function nlCrawl(page) {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  NL CRAWL  (single-shot + refinement chains) ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const stateMap = new Map();
  const transitions = [];
  const controlsExercised = new Set();
  const footprints = [];
  const nlStates = {};
  const chainResults = [];

  // Baseline
  await resetFilters(page);
  const baseState = await captureState(page);
  const baseScreenshot = await takeScreenshot(page, hashState(baseState));
  const baseHash = addState(stateMap, baseState, baseScreenshot, 0);
  console.log(`  Baseline: ${baseHash} (${baseState.D.length} products)\n`);

  // ── Phase 1: Single-shot utterances (depth 0→1) ──
  console.log("  ── Phase 1: Single-shot utterances ──\n");
  for (let i = 0; i < NL_UTTERANCES.length; i++) {
    const { id, text } = NL_UTTERANCES[i];
    console.log(`  [${i + 1}/${NL_UTTERANCES.length}] "${text}"`);

    await resetFilters(page);
    const preState = await captureState(page);
    const preHash = addState(stateMap, preState, null, 0);

    await sendChat(page, text);

    const postState = await captureState(page);
    const postHash = hashState(postState);
    const screenshot = await takeScreenshot(page, postHash);
    addState(stateMap, postState, screenshot, 1);

    const fp = computeFootprint(preState, postState);
    fp.forEach(c => controlsExercised.add(c));

    footprints.push({ utterance: id, text, footprint: fp });
    nlStates[id] = { state: postState, hash: postHash };
    transitions.push({ from: preHash, action: `NL: "${text}"`, to: postHash });

    console.log(`    → ${postHash}  [${postState.D.length}p]  fp: [${fp.join(", ")}]\n`);
  }

  // ── Phase 2: Refinement chains (multi-turn, depth 1→2→…) ──
  console.log("  ── Phase 2: Refinement chains (no reset between steps) ──\n");
  for (const chain of NL_CHAINS) {
    console.log(`  Chain: ${chain.id}`);
    console.log(`    ${chain.description}`);

    await resetFilters(page);
    let prevState = await captureState(page);
    let prevHash = addState(stateMap, prevState, null, 0);
    const chainSteps = [];

    for (let s = 0; s < chain.steps.length; s++) {
      const utterance = chain.steps[s];
      console.log(`    [step ${s + 1}/${chain.steps.length}] "${utterance}"`);

      // Do NOT reset — this is the whole point of chains
      await sendChat(page, utterance);

      const postState = await captureState(page);
      const postHash = hashState(postState);
      const screenshot = await takeScreenshot(page, postHash);
      addState(stateMap, postState, screenshot, s + 1);

      const fp = computeFootprint(prevState, postState);
      fp.forEach(c => controlsExercised.add(c));

      transitions.push({
        from: prevHash,
        action: `NL-chain[${chain.id}]: "${utterance}"`,
        to: postHash,
      });

      chainSteps.push({
        step: s + 1,
        utterance,
        stateHash: postHash,
        footprint: fp,
        productCount: postState.D.length,
      });

      console.log(`      → ${postHash}  [${postState.D.length}p]  fp: [${fp.join(", ")}]`);
      prevState = postState;
      prevHash = postHash;
    }

    // Compare final chain state vs equivalent single-shot (if defined)
    const finalHash = chainSteps[chainSteps.length - 1].stateHash;
    let equivalenceCheck = null;
    if (chain.equivalent) {
      const equivState = nlStates[
        Object.keys(nlStates).find(k => {
          const u = NL_UTTERANCES.find(u => u.id === k);
          return u && u.text === chain.equivalent;
        }) || ""
      ];
      // If we already have the equivalent from phase 1
      if (equivState) {
        equivalenceCheck = {
          equivalent: chain.equivalent,
          equivalentHash: equivState.hash,
          chainFinalHash: finalHash,
          match: equivState.hash === finalHash,
        };
        console.log(`    ⇔ Equivalence with "${chain.equivalent}": ${equivState.hash === finalHash ? "✅ MATCH" : "❌ MISMATCH"}`);
        console.log(`      Chain final: ${finalHash}  Single-shot: ${equivState.hash}`);
      } else {
        // Run the equivalent utterance fresh to compare
        console.log(`    ⇔ Running equivalent: "${chain.equivalent}"`);
        await resetFilters(page);
        await sendChat(page, chain.equivalent);
        const eqState = await captureState(page);
        const eqHash = hashState(eqState);
        const eqScreenshot = await takeScreenshot(page, eqHash);
        addState(stateMap, eqState, eqScreenshot, 1);

        equivalenceCheck = {
          equivalent: chain.equivalent,
          equivalentHash: eqHash,
          chainFinalHash: finalHash,
          match: eqHash === finalHash,
        };
        console.log(`      Chain final: ${finalHash}  Single-shot: ${eqHash} → ${eqHash === finalHash ? "✅ MATCH" : "❌ MISMATCH"}`);
      }
    }

    chainResults.push({
      id: chain.id,
      description: chain.description,
      steps: chainSteps,
      equivalenceCheck,
    });
    console.log();
  }

  console.log(`  NL complete: ${stateMap.size} states, ${transitions.length} transitions\n`);
  return { stateMap, transitions, controlsExercised, footprints, nlStates, baseHash, chainResults };
}

// ─── MR Checks ──────────────────────────────────────────────────────────────
function checkMrSe(nlStates) {
  const base = nlStates["nl_base"], caps = nlStates["nl_caps"];
  if (!base || !caps) return null;
  const violation = base.hash !== caps.hash;
  return {
    relation: "MR_SE (case insensitivity)",
    base: "show electronics under $100 sorted by rating",
    variant: "SHOW ELECTRONICS UNDER $100 SORTED BY RATING",
    baseStateHash: base.hash, variantStateHash: caps.hash,
    violation,
    detail: violation
      ? "FAIL: Caps variant produced different state — NL mediator is case-sensitive"
      : "PASS: Both variants produced identical state",
  };
}

// ─── DOT export (for Graphviz) ──────────────────────────────────────────────
function toDot(label, graph, baselineHash) {
  const lines = [`digraph "${label}" {`, '  rankdir=LR;', '  node [shape=circle, style=filled, fontsize=8, fontname="Courier"];',
    '  edge [fontsize=7, fontname="Courier"];'];

  // Compute depth via BFS
  const adj = {};
  graph.transitions.forEach(t => { if (t.from !== t.to) { (adj[t.from] = adj[t.from] || []).push(t.to); }});
  const depthMap = {}; depthMap[baselineHash] = 0;
  const q = [baselineHash];
  while (q.length) { const c = q.shift(); for (const n of (adj[c] || [])) if (depthMap[n] === undefined) { depthMap[n] = depthMap[c] + 1; q.push(n); }}

  // Group by depth for subgraph ranking
  const byDepth = {};
  graph.states.forEach(s => {
    const d = depthMap[s.hash] ?? 0;
    (byDepth[d] = byDepth[d] || []).push(s);
  });

  for (const [d, states] of Object.entries(byDepth).sort((a,b) => a[0]-b[0])) {
    lines.push(`  subgraph cluster_d${d} { rank=same; label="depth ${d}"; style=dashed; color="#888888";`);
    for (const s of states) {
      const color = s.hash === baselineHash ? '#ffd700' : '#58a6ff';
      const lbl = `${s.hash.slice(0,6)}\\n${s.D.length}p`;
      lines.push(`    "${s.hash}" [label="${lbl}", fillcolor="${color}40", color="${color}"];`);
    }
    lines.push('  }');
  }

  // Collapse parallel edges
  const edgeMap = {};
  graph.transitions.forEach(t => {
    if (t.from === t.to) return;
    const k = `${t.from}->${t.to}`;
    (edgeMap[k] = edgeMap[k] || { from: t.from, to: t.to, actions: [] }).actions.push(t.action);
  });
  for (const e of Object.values(edgeMap)) {
    const lbl = e.actions.length <= 2
      ? e.actions.map(a => a.replace(/"/g, '\\"').slice(0, 30)).join('\\n')
      : `${e.actions[0].replace(/"/g, '\\"').slice(0,25)}...\\n+${e.actions.length - 1} more`;
    lines.push(`  "${e.from}" -> "${e.to}" [label="${lbl}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}

// ─── Report ──────────────────────────────────────────────────────────────────
function generateReport(dmResult, nlResult) {
  const totalControls = CONTROLS.length;
  const dmStates = dmResult.stateMap.size;
  const nlStates = nlResult.stateMap.size;
  const dmControlsEx = dmResult.controlsExercised.size;
  const nlControlsEx = nlResult.controlsExercised.size;
  const covNL = nlControlsEx / totalControls;
  const mrSe = checkMrSe(nlResult.nlStates);

  // Shared states
  const dmHashes = new Set([...dmResult.stateMap.keys()]);
  const nlHashes = new Set([...nlResult.stateMap.keys()]);
  const shared = [...nlHashes].filter(h => dmHashes.has(h)).length;

  // Console
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║          COMPARISON REPORT                    ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log("  ┌──────────────────────────┬────────┬────────┐");
  console.log("  │ Metric                   │   DM   │   NL   │");
  console.log("  ├──────────────────────────┼────────┼────────┤");
  console.log(`  │ Total controls |C|       │ ${String(totalControls).padStart(6)} │ ${String(totalControls).padStart(6)} │`);
  console.log(`  │ States reached           │ ${String(dmStates).padStart(6)} │ ${String(nlStates).padStart(6)} │`);
  console.log(`  │ Shared states            │ ${String(shared).padStart(6)} │ ${String(shared).padStart(6)} │`);
  console.log(`  │ Controls exercised       │ ${String(dmControlsEx).padStart(6)} │ ${String(nlControlsEx).padStart(6)} │`);
  console.log(`  │ Coverage                 │ ${(dmControlsEx/totalControls*100).toFixed(0).padStart(5)}% │ ${(covNL*100).toFixed(0).padStart(5)}% │`);
  console.log(`  │ Max crawl depth          │ ${String(MAX_DEPTH).padStart(6)} │  chain │`);
  console.log("  └──────────────────────────┴────────┴────────┘\n");

  if (mrSe) console.log(`  MR_SE: ${mrSe.violation ? "❌ VIOLATION" : "✅ PASS"} — ${mrSe.detail}\n`);

  console.log("  NL Footprints:");
  nlResult.footprints.forEach(fp => console.log(`    ${fp.utterance.padEnd(14)} → [${fp.footprint.join(", ") || "none"}]`));

  if (nlResult.chainResults.length > 0) {
    console.log("\n  NL Chains:");
    nlResult.chainResults.forEach(c => {
      console.log(`    ${c.id}: ${c.steps.length} steps`);
      if (c.equivalenceCheck) {
        console.log(`      Equivalence: ${c.equivalenceCheck.match ? "✅" : "❌"} chain=${c.equivalenceCheck.chainFinalHash} single=${c.equivalenceCheck.equivalentHash}`);
      }
    });
  }
  console.log();

  const stateArrayFromMap = m => [...m.entries()].map(([hash, s]) => ({ hash, ...s }));

  // Theoretical max
  const theoreticalMax = CONTROLS.reduce((acc, c) => acc * c.values.length, 1);

  return {
    meta: { timestamp: new Date().toISOString(), appUrl: APP_URL, maxDepth: MAX_DEPTH, maxStates: MAX_STATES, screenshotsDir: "screenshots/", theoreticalMaxStates: theoreticalMax },
    summary: {
      totalControls, sharedStates: shared,
      dm: { statesReached: dmStates, controlsExercised: dmControlsEx, controlsList: [...dmResult.controlsExercised] },
      nl: { statesReached: nlStates, controlsExercised: nlControlsEx, controlsList: [...nlResult.controlsExercised], covNL },
    },
    mrSeViolations: mrSe ? [mrSe] : [],
    dmStateFlowGraph: { states: stateArrayFromMap(dmResult.stateMap), transitions: dmResult.transitions },
    nlStateFlowGraph: { states: stateArrayFromMap(nlResult.stateMap), transitions: nlResult.transitions },
    nlControlFootprints: nlResult.footprints,
    nlChainResults: nlResult.chainResults,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nCrawler  depth=${MAX_DEPTH}  max-states=${MAX_STATES || '∞'}  headless=${HEADLESS}`);
  console.log(`Target: ${APP_URL}\n`);

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: "networkidle" });
    console.log("Page loaded.\n");

    const dmResult = await dmCrawl(page);
    const nlResult = await nlCrawl(page);
    const report = generateReport(dmResult, nlResult);

    // Save JSON
    fs.writeFileSync("coverage_report.json", JSON.stringify(report, null, 2));
    console.log("  Saved: coverage_report.json");

    // Save DOT files for Graphviz
    fs.writeFileSync("dm_graph.dot", toDot("DM State-Flow Graph", report.dmStateFlowGraph, dmResult.baseHash));
    fs.writeFileSync("nl_graph.dot", toDot("NL State-Flow Graph", report.nlStateFlowGraph, nlResult.baseHash));
    console.log("  Saved: dm_graph.dot, nl_graph.dot");
    console.log("    → Render with: dot -Tpng dm_graph.dot -o dm_graph.png");
    console.log("    → Or: dot -Tsvg dm_graph.dot -o dm_graph.svg\n");

    console.log(`  Screenshots: ${SCREENSHOTS_DIR}/`);
    console.log(`  Visualizer:  npx serve . → open visualizer.html\n`);
  } catch (err) {
    console.error("Crawler error:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
