---
marp: true

paginate: true

---

# Research Update: DM vs NL Reachability
## Operationalizing the Formal Model with a Crawler Tool

**Ninad Chaudhari** & Sharmista Kuri
*April 2026*


---

# Recap: What We Formalized

Our paper defines **NL-mediated GUIs** as systems where an LLM mediator **M** translates utterances into control activations over a finite control surface **C**:

$$u \xrightarrow{M} V' \subseteq C \xrightarrow{A} D'$$

---

**Constructs now implemented in the tool:**

| Formal Concept | Tool Implementation |
|---|---|
| State $\sigma = \langle V, H, P, D \rangle$ | |
| Observation $O(\sigma) = \langle V, D \rangle$ | SHA-256 hash of `{V, D}` for dedup |
| Control surface $C$ | 5 controls: category, maxPrice, minRating, inStockOnly, sort |
| Footprint $fp(u, \sigma) = M(\sigma,u) \triangle \sigma.V$ | Diff of control values before/after NL utterance |
| $Cov_{NL}(U)$ | `|⋃ fp(u,σ₀)| / |C|` = **100%** (all 5 controls reached) |

---

# Tool Architecture: Two Crawl Strategies

<div class="columns">
<div class="col">

## **DM Crawl** (CrawlJax-style)
BFS over the state space via clicks

- Depth 0 → Baseline σ₀ (1 state)
- Depth 1 → Single control changes
- Depth 2 → Compound combinations
- Terminates when no new states

Each action = one control change
State = `O(σ) = {V, D}`

**Theoretical max:**
`6 × 4 × 5 × 2 × 5 = 1,200 states`

</div>
<div class="col">

## *NL Crawl* (Chat-mediated)
Utterances sent to LLM mediator M

**Phase 1:** Single-shot commands
→ reset between each (clean σ₀)

**Phase 2:** Refinement chains
→ no reset , tests *context carry-over*

```
"show electronics"
→ "now under $100"      ← H evolves
→ "sort by rating"
```

**Tests MR_AC:** Does chain result = single compositional utterance?

</div>
</div>

---

# Results: Reachability Comparison

| Metric | **DM** (depth=2) | *NL* (8 utterances) |
|---|:---:|:---:|
| Controls \|C\| | 5 | 5 |
| **States reached** | **129** | **8** |
| Controls exercised | 5 (100%) | 5 (100%) |
| $Cov_{NL}$ | , | **100%** |
| MR_SE violations | n/a | **1 (FAIL)** |
| Theoretical max | 1,200 | ∞ (language is unbounded) |

**Key finding:** NL exercises all controls but reaches only **6.2%** of the states that DM finds at depth 2. The NL mediator maps the infinite utterance space to a **sparse subset** of the finite state space.

> This validates our formal claim: *"the NL channel is a mediator that translates user utterances into selections over C, not a synthesizer of novel widgets."*

---

# MR_SE Violation: Synonym Blindness Detected

Our formal relation:

$$MR_{SE}: \forall \sigma, u_1, u_2. \ Syn(u_1,u_2) \implies O(\sigma \xrightarrow{u_1} \sigma') = O(\sigma \xrightarrow{u_2} \sigma'')$$

**Test case executed by the tool:**

| | Utterance | State Hash | Products |
|---|---|---|---|
| $u_1$ | `show electronics under $100 sorted by rating` | `0041e330` | 3 |
| $u_2$ | `SHOW ELECTRONICS UNDER $100 SORTED BY RATING` | `fe84c897` | 2 |

**Observation** , The CAPS variant additionally set `minRating=4`, dropping 1 product.

The mediator **M** is case-sensitive: `M(σ₀, u₁) ≠ M(σ₀, u₂)` despite `Syn(u₁, u₂)`.

This is a **Synonym Blindness** fault (Table 2 in the paper).

---

# NL Footprints Validate the Formal Model

The footprint `fp(u, σ) = M(σ, u) △ σ.V` tells us which controls each utterance actually toggles:

| Utterance | $fp(u, \sigma_0)$ | \|fp\| |
|---|---|:---:|
| "show electronics under $100 sorted by rating" | category, maxPrice, sort | 3 |
| "show all products" | ∅ | 0 |
| "show clothing items" | category | 1 |
| "show items under $50" | maxPrice | 1 |
| "sort by price low to high" | sort | 1 |
| "show in stock items only" | inStockOnly | 1 |

---

**Observations:**
- Compositional utterances activate **multiple controls** in one shot (fp = 3)
- Simple commands are **precise** (fp = 1)
- "show all products" = identity transition (fp = ∅) , returns to σ₀
- This data feeds directly into $Cov_{NL}$ and independence checks for $MR_{CA}$

---

# State-Event Flow Graph: DM vs NL

<div class="columns">
<div class="col">

### **DM Graph** (129 states)
- Dense, multi-layered
- Every control combination reachable
- Star at depth 1 → mesh at depth 2
- Bidirectional edges between peers
  (e.g., books ↔ clothing at depth 1)

**Interpretation:** Complete but expensive.
CrawlJax-style BFS is exhaustive.

</div>
<div class="col">

### *NL Graph* (8 states)
- Sparse, mostly star topology
- Single utterance can jump to depth-2 equivalent states
- MR_SE violation creates divergent paths from σ₀

**Interpretation:** Efficient but partial.
NL mediator acts as a **lossy compression** of the state space.

</div>
</div>

> **The gap:** 129 vs 8 states is not a bug , it's the fundamental asymmetry between
> *exhaustive enumeration* (DM) and *intent-driven navigation* (NL). Our MRs detect
> when the compression introduces faults.

---

# Next Steps

### Implementing remaining MRs
- **MR_CA** (Commuting Actions): Refinement chains already capture ordered pairs , need to test both orderings
- **MR_REV** (Reversibility): "show electronics" → "show all" , does it fully restore σ₀?
- **MR_AC** (Additive Constraining): Chain equivalence checks already running

### Extending the tool
- **Automated utterance generation** via paraphrase models (operationalizing `G(MRᵢ)` from Algorithm 1)
- **Statistical tolerance** ε for non-determinism: repeat each utterance N times
- **CovNL tracking** across utterance sets , find the minimal U that maximizes coverage

### Toward the coverage criterion
- Map NL-reachable states onto the DM state-flow graph
- Define **NL adequacy** as: ∀ depth-1 DM states, ∃ u ∈ U reaching the same state
- Measure the **coverage gap** as states in `Reach_DM \ Reach_NL`

<!-- _footer: "" -->
