// Subagent bootstrap-vs-useful waterfall card
// (KP ideas/csv-subagent-bootstrap-vs-useful-waterfall-card).
// Pure module — no vscode imports — so the aggregator + renderer are
// fixture-testable.
//
// Codex users report multi-agent fan-out burning *more* weekly allowance than
// a single agent, because every child pays a fixed bootstrap (system prompt,
// AGENTS.md/rules, tool schemas, skill catalogue, env discovery) before doing
// any unique work (openai/codex#39808). This card decomposes each fan-out
// family's per-child spend into bootstrap | useful | total across every
// backend the CSV index knows, and warns when the median child spends more
// than half its tokens just booting.
//
// Bootstrap estimation ladder (per child, best evidence wins):
//   1. measured  — the child's first turn's input + cache tokens (per-turn
//      usage from the turn table): the context bought before the first
//      output token is fixed cost by definition.
//   2. sibling-min — with ≥2 same-backend siblings and no per-turn data, the
//      cheapest sibling's total ≈ pure bootstrap (the child that did nearly
//      nothing still paid the fixed cost).
//   3. per-message — total / max(1, messages): a coarse "one exchange" floor,
//      only when a child has no siblings and no turn data.
// Estimated (non-measured) figures are marked approximate in the UI.
//
// Read-only over the persisted session index: no live vendor APIs, no
// child-killing — fan-out budget enforcement lives in CB, not here.

export const SUBAGENT_BOOTSTRAP_SCHEMA = "code-sessions/subagent-bootstrap-card@1";

/** Minimal session-row shape (SessionStore row or Insights mirror). */
export interface BootstrapSessionInput {
  session_id?: string | null;
  source?: string | null;
  kind?: string | null;
  parent_session_id?: string | null;
  title?: string | null;
  first_user_msg?: string | null;
  message_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_usd?: number | null;
}

/** First-turn usage for a child (from the per-turn token columns). */
export interface FirstTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type BootstrapBasis = "measured" | "sibling-min" | "per-message";

export interface ChildBreakdown {
  sessionId: string;
  label: string;
  source: string;
  totalTokens: number;
  bootstrapTokens: number;
  usefulTokens: number;
  /** bootstrapTokens / totalTokens (0 when total is 0). */
  bootstrapShare: number;
  basis: BootstrapBasis;
}

export interface FanoutFamily {
  parentId: string;
  parentLabel: string;
  backends: string[];
  children: ChildBreakdown[];
  childTotalTokens: number;
  bootstrapTotalTokens: number;
  medianBootstrapShare: number;
  /** True when medianBootstrapShare exceeds the warn threshold. */
  bootstrapHeavy: boolean;
}

export interface SubagentBootstrapCard {
  families: FanoutFamily[];
  /** Child transcripts considered (before the min-children family cut). */
  childSessions: number;
  warnShare: number;
}

export interface SubagentBootstrapOptions {
  /** Map child session_id → first-turn usage (measured bootstrap). */
  firstTurnUsage?: Map<string, FirstTurnUsage>;
  /** Minimum children for a family to count as fan-out (default 2). */
  minChildren?: number;
  /** Max families on the card (default 4). */
  maxFamilies?: number;
  /** Max children listed per family (default 8). */
  maxChildren?: number;
  /** Median child bootstrap share that flips the warning chip (default 0.5). */
  warnShare?: number;
}

function tokensOf(r: BootstrapSessionInput): number {
  return (
    (r.input_tokens ?? 0) +
    (r.output_tokens ?? 0) +
    (r.cache_read_tokens ?? 0) +
    (r.cache_write_tokens ?? 0)
  );
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function childLabel(r: BootstrapSessionInput): string {
  const raw = (r.title || r.first_user_msg || r.session_id || "").trim();
  return raw.slice(0, 70);
}

/** Decompose fan-out families into per-child bootstrap | useful | total. */
export function computeSubagentBootstrap(
  rows: BootstrapSessionInput[],
  opts: SubagentBootstrapOptions = {},
): SubagentBootstrapCard {
  const minChildren = opts.minChildren ?? 2;
  const maxFamilies = opts.maxFamilies ?? 4;
  const maxChildren = opts.maxChildren ?? 8;
  const warnShare = opts.warnShare ?? 0.5;
  const firstTurn = opts.firstTurnUsage;

  const parentTitleById = new Map<string, string>();
  const childrenByParent = new Map<string, BootstrapSessionInput[]>();
  let childSessions = 0;
  for (const r of rows) {
    const kind = r.kind ?? "session";
    if (kind === "session") {
      if (r.session_id) parentTitleById.set(r.session_id, childLabel(r));
      continue;
    }
    if (kind !== "subagent" && kind !== "workflow") continue;
    if (!r.parent_session_id || !r.session_id) continue;
    childSessions++;
    const g = childrenByParent.get(r.parent_session_id);
    if (g) g.push(r);
    else childrenByParent.set(r.parent_session_id, [r]);
  }

  const families: FanoutFamily[] = [];
  for (const [parentId, kids] of childrenByParent) {
    if (kids.length < minChildren) continue;

    // Sibling-min fallback pool: cheapest non-zero same-backend sibling total.
    const minTotalBySource = new Map<string, number>();
    for (const k of kids) {
      const t = tokensOf(k);
      if (t <= 0) continue;
      const src = k.source || "claude";
      const cur = minTotalBySource.get(src);
      if (cur === undefined || t < cur) minTotalBySource.set(src, t);
    }
    const siblingCountBySource = new Map<string, number>();
    for (const k of kids) {
      const src = k.source || "claude";
      siblingCountBySource.set(src, (siblingCountBySource.get(src) ?? 0) + 1);
    }

    const children: ChildBreakdown[] = kids.map((k) => {
      const total = tokensOf(k);
      const src = k.source || "claude";
      const ft = firstTurn?.get(k.session_id!);
      let bootstrap: number;
      let basis: BootstrapBasis;
      if (ft) {
        // Context bought before the first output token is fixed cost; the
        // first turn's output already counts as useful work.
        bootstrap = ft.input_tokens + ft.cache_read_tokens + ft.cache_write_tokens;
        basis = "measured";
      } else if ((siblingCountBySource.get(src) ?? 0) >= 2 && minTotalBySource.has(src)) {
        bootstrap = minTotalBySource.get(src)!;
        basis = "sibling-min";
      } else {
        bootstrap = total / Math.max(1, k.message_count ?? 1);
        basis = "per-message";
      }
      bootstrap = Math.min(bootstrap, total);
      return {
        sessionId: k.session_id!,
        label: childLabel(k),
        source: src,
        totalTokens: total,
        bootstrapTokens: bootstrap,
        usefulTokens: total - bootstrap,
        bootstrapShare: total > 0 ? bootstrap / total : 0,
        basis,
      };
    });

    children.sort((a, b) => b.totalTokens - a.totalTokens);
    const childTotalTokens = children.reduce((n, c) => n + c.totalTokens, 0);
    const bootstrapTotalTokens = children.reduce((n, c) => n + c.bootstrapTokens, 0);
    const medianShare = median(children.filter((c) => c.totalTokens > 0).map((c) => c.bootstrapShare));
    families.push({
      parentId,
      parentLabel: parentTitleById.get(parentId) || parentId,
      backends: [...new Set(children.map((c) => c.source))].sort(),
      children: children.slice(0, maxChildren),
      childTotalTokens,
      bootstrapTotalTokens,
      medianBootstrapShare: medianShare,
      bootstrapHeavy: medianShare > warnShare,
    });
  }

  families.sort((a, b) => b.childTotalTokens - a.childTotalTokens);
  return { families: families.slice(0, maxFamilies), childSessions, warnShare };
}

// --------------------------------------------------------------------------- //
// HTML
// --------------------------------------------------------------------------- //

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTokShort(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

/** Insights section ("" when no fan-out families). */
export function renderSubagentBootstrapSectionHtml(card: SubagentBootstrapCard): string {
  if (card.families.length === 0) return "";

  const blocks = card.families
    .map((f) => {
      const maxTotal = Math.max(1, ...f.children.map((c) => c.totalTokens));
      const rows = f.children
        .map((c) => {
          const barW = (c.totalTokens / maxTotal) * 100;
          const bootW = c.totalTokens > 0 ? (c.bootstrapTokens / c.totalTokens) * 100 : 0;
          const approx = c.basis !== "measured";
          const basisTitle =
            c.basis === "measured"
              ? "Measured from the child's first-turn usage"
              : c.basis === "sibling-min"
                ? "Estimated: cheapest same-backend sibling's total ≈ fixed bootstrap"
                : "Estimated: total / messages as a one-exchange floor";
          return `<tr>
        <td class="sbw-label" title="${esc(c.sessionId)}">${esc(c.label.slice(0, 48))}</td>
        <td>${esc(c.source)}</td>
        <td class="sbw-bar-cell"><div class="sbw-bar" style="width:${barW.toFixed(1)}%"><div class="sbw-boot" style="width:${bootW.toFixed(1)}%"></div></div></td>
        <td class="num" title="${esc(basisTitle)}">${approx ? "~" : ""}${esc(fmtTokShort(c.bootstrapTokens))}</td>
        <td class="num">${esc(fmtTokShort(c.usefulTokens))}</td>
        <td class="num">${esc(fmtTokShort(c.totalTokens))}</td>
        <td class="num${c.bootstrapShare > card.warnShare ? " sbw-hot" : ""}">${(c.bootstrapShare * 100).toFixed(0)}%</td>
      </tr>`;
        })
        .join("");
      const warn = f.bootstrapHeavy
        ? `<span class="sbw-chip" title="Median child spent over ${Math.round(card.warnShare * 100)}% of its tokens on bootstrap — fewer, bigger children would buy the fixed cost fewer times">bootstrap-heavy fan-out ${(f.medianBootstrapShare * 100).toFixed(0)}%</span>`
        : "";
      return `<div class="sbw-family">
    <div class="sbw-parent">${esc(f.parentLabel.slice(0, 80))} <span class="sbw-meta">${f.children.length} children · ${esc(f.backends.join(" + "))} · ${esc(fmtTokShort(f.childTotalTokens))} child tokens (${esc(fmtTokShort(f.bootstrapTotalTokens))} bootstrap)</span> ${warn}</div>
    <table class="sbw-table"><tr><th>child</th><th>backend</th><th>waterfall</th><th>bootstrap</th><th>useful</th><th>total</th><th>share</th></tr>${rows}</table>
  </div>`;
    })
    .join("");

  return `<section class="sbw-card" data-schema="${esc(SUBAGENT_BOOTSTRAP_SCHEMA)}">
  <div class="sbw-head"><span class="sbw-title">Subagent bootstrap vs useful work</span></div>
  <div class="sbw-sub">Every spawned child pays a fixed bootstrap (rules, tool schemas, skills, env discovery) before unique work — ${card.childSessions} child transcript${card.childSessions === 1 ? "" : "s"} decomposed per fan-out. "~" figures are estimated, not measured.</div>
  ${blocks}
  <div class="sbw-disclaimer">Read-only over the local session index — no vendor APIs, no child control. Fan-out budget enforcement belongs to the host (Code Build), not this card.</div>
</section>`;
}

/** CSS for Insights / harness — keep in sync with `.sbw-*` markup above. */
export const SUBAGENT_BOOTSTRAP_CARD_CSS = `
.sbw-card { background: var(--card-bg, var(--vscode-editorWidget-background, #1e1e1e)); border: 1px solid var(--border, var(--vscode-panel-border, #333)); border-radius: 6px; padding: 12px 14px; margin-top: 8px; }
.sbw-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.sbw-title { font-size: 11px; text-transform: uppercase; color: var(--muted, var(--vscode-descriptionForeground, #999)); letter-spacing: 0.5px; font-weight: 600; }
.sbw-sub { font-size: 12px; color: var(--muted, var(--vscode-descriptionForeground, #999)); line-height: 1.45; margin-bottom: 8px; }
.sbw-family { margin-top: 10px; }
.sbw-parent { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.sbw-meta { font-weight: 400; color: var(--muted, var(--vscode-descriptionForeground, #999)); font-size: 11px; }
.sbw-chip { display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-inputValidation-errorForeground, #f88); border: 1px solid var(--vscode-inputValidation-errorForeground, #f88); border-radius: 8px; padding: 1px 7px; margin-left: 6px; vertical-align: middle; }
.sbw-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 2px; }
.sbw-table th, .sbw-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, var(--vscode-panel-border, #333)); }
.sbw-table th { color: var(--muted, var(--vscode-descriptionForeground, #999)); font-weight: 500; font-size: 10px; text-transform: uppercase; }
.sbw-table td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.sbw-table th:nth-child(n+4) { text-align: right; }
.sbw-label { font-family: var(--vscode-editor-font-family, monospace); }
.sbw-bar-cell { width: 30%; min-width: 120px; }
.sbw-bar { height: 10px; border-radius: 2px; background: var(--vscode-charts-green, #3a3); overflow: hidden; min-width: 2px; }
.sbw-boot { height: 100%; background: var(--vscode-charts-orange, #d90); }
.sbw-hot { color: var(--vscode-inputValidation-errorForeground, #f88); font-weight: 600; }
.sbw-disclaimer { font-size: 11px; color: var(--muted, var(--vscode-descriptionForeground, #999)); margin-top: 10px; line-height: 1.45; border-top: 1px solid var(--border, var(--vscode-panel-border, #333)); padding-top: 8px; }
`;
