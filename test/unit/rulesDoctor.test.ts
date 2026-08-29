import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildDoctorReport,
  classifySection,
  countHits,
  dashEncodeCwd,
  dedupeSections,
  discoverRuleFiles,
  exportChecklist,
  extractSignals,
  filterWorkspaceSessions,
  parseRuleSections,
  renderDoctorCardHtml,
  runRulesDoctor,
  sessionMatchesWorkspace,
  stripFrontmatter,
  type DoctorTurnSource,
  type JoinableSession,
  type RuleSection,
} from "../../src/rulesDoctor";

function section(body: string, heading = "Some heading", file = "AGENTS.md"): RuleSection {
  return { file, heading, startLine: 1, body };
}

describe("discoverRuleFiles", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rules-doctor-"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# hi\n");
    fs.writeFileSync(path.join(root, "Agents.md"), "# hi\n"); // repo-style casing
    fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "rules", "style.mdc"), "body\n");
    fs.writeFileSync(path.join(root, ".cursor", "rules", "notes.txt"), "ignored\n");
    fs.writeFileSync(path.join(root, "README.md"), "not a rules file\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds CLAUDE.md, AGENTS.md (any casing), and .cursor/rules/*.mdc only", () => {
    const found = discoverRuleFiles(root).map((f) => f.relPath).sort();
    expect(found).toEqual([".cursor/rules/style.mdc", "Agents.md", "CLAUDE.md"]);
  });

  it("returns [] for a missing root", () => {
    expect(discoverRuleFiles(path.join(root, "nope"))).toEqual([]);
  });
});

describe("parseRuleSections", () => {
  it("splits on ##/### and ignores headings inside code fences", () => {
    const text = [
      "## Real section",
      "body one",
      "```",
      "## not a heading",
      "```",
      "### Sub section",
      "body two",
    ].join("\n");
    const sections = parseRuleSections(text, "CLAUDE.md");
    expect(sections.map((s) => s.heading)).toEqual(["Real section", "Sub section"]);
    expect(sections[0].body).toContain("## not a heading");
    expect(sections[1].body).toContain("body two");
  });

  it("strips .mdc YAML frontmatter and keeps line anchors past it", () => {
    const text = ["---", "alwaysApply: true", "globs: '*.ts'", "---", "## After fm", "body"].join("\n");
    const { removedLines } = stripFrontmatter(text);
    expect(removedLines).toBe(4);
    const sections = parseRuleSections(text, ".cursor/rules/x.mdc");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("After fm");
    expect(sections[0].startLine).toBe(5);
    expect(sections[0].body).not.toContain("alwaysApply");
  });

  it("headingless file becomes one section named after the file", () => {
    const sections = parseRuleSections("just prose\nmore prose", "AGENTS.md");
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("AGENTS.md");
    expect(sections[0].body).toContain("just prose");
  });

  it("dedupes identical bodies across files (CLAUDE.md ↔ AGENTS.md symlink)", () => {
    const a = parseRuleSections("## Shared\nsame body text here", "CLAUDE.md");
    const b = parseRuleSections("## Shared\nsame body text here", "AGENTS.md");
    const unique = dedupeSections([...a, ...b]);
    expect(unique).toHaveLength(1);
    expect(unique[0].file).toBe("CLAUDE.md");
  });
});

describe("signals + classification", () => {
  it("title-only generic heading is unscorable, never a candidate", () => {
    const s = classifySection(section("", "Testing"));
    expect(s.cls).toBe("unscorable");
    expect(s.signals).toEqual([]);
  });

  it("generic imperatives alone never produce a signal", () => {
    const s = classifySection(section("Always prefer tests. Never use npm."));
    expect(s.cls).toBe("unscorable");
  });

  it("code spans, paths, and quoted phrases are distinctive signals", () => {
    const s = classifySection(
      section(
        "Run `npm run compile` first. Edit src/rulesDoctor.ts and check \"the wasm statement cache\" note."
      )
    );
    expect(s.cls).toBe("scorable");
    const kinds = s.signals.map((x) => x.kind);
    expect(kinds).toContain("code");
    expect(kinds).toContain("path");
    expect(kinds).toContain("quote");
  });

  it("prose n-grams clear the distinctiveness floor; stop/junk-only windows do not", () => {
    const distinctive = extractSignals(
      section("The trajectory renderer batches webview snapshots before hydration completes")
    );
    expect(distinctive.some((sig) => sig.kind === "ngram")).toBe(true);
    const junk = extractSignals(section("You should always make sure to do this and not that"));
    expect(junk).toEqual([]);
  });

  it("generic slash tokens (and/or, CI/CD) are not path signals", () => {
    const s = classifySection(section("Use CI/CD and/or w/e you like"));
    expect(s.signals.filter((sig) => sig.kind === "path")).toEqual([]);
  });

  it("n-gram windows shed trailing punctuation so they match transcript prose", () => {
    const sigs = extractSignals(
      section("The trajectory renderer batches webview snapshots eagerly.")
    );
    const ngram = sigs.find((x) => x.kind === "ngram");
    expect(ngram?.text.endsWith(".")).toBe(false);
  });

  it("short Never/Do-not bullets shield the section as protected", () => {
    const s = classifySection(section("- Never push directly to main\n- other stuff `some-signal-here`"));
    expect(s.cls).toBe("protected");
  });

  it("lowercase and curly-apostrophe never-lines also shield", () => {
    expect(classifySection(section("- never commit secrets")).cls).toBe("protected");
    expect(classifySection(section("* Don’t force-push shared branches")).cls).toBe("protected");
  });

  it("a >160-char never-line does not shield", () => {
    const long = "- Never " + "x".repeat(170);
    const s = classifySection(section(long));
    expect(s.cls).not.toBe("protected");
  });
});

describe("countHits", () => {
  const turns = [
    { sessionId: "s1", text: "please run npm run compile before committing" },
    { sessionId: "s1", text: "ok I ran `npm run compile`, it is green" },
    { sessionId: "s2", text: "unrelated chatter about the weather" },
  ];

  it("counts distinct sessions (primary) and turns (secondary), case-insensitive", () => {
    const s = classifySection(section("Always run `npm run compile` before commit."));
    countHits([s], turns);
    expect(s.sessionHits).toBe(1);
    expect(s.turnHits).toBe(2);
    expect(s.matchedSignal?.text).toBe("npm run compile");
  });

  it("absent signal scores zero", () => {
    const s = classifySection(section("Consult `docs/nonexistent-ritual.md` before deploys."));
    countHits([s], turns);
    expect(s.sessionHits).toBe(0);
    expect(s.turnHits).toBe(0);
  });
});

describe("workspace ↔ session join", () => {
  const ws = "/Users/me/projects/unpolarize/code-sessions-vscode";
  const claudeSession: JoinableSession = {
    session_id: "c1",
    source: "claude",
    project_path:
      "/Users/me/.claude/projects/-Users-me-projects-unpolarize-code-sessions-vscode",
  };
  const codexSession: JoinableSession = { session_id: "x1", source: "codex", project_path: ws };
  const grokOther: JoinableSession = {
    session_id: "g1",
    source: "grok",
    project_path: "/Users/me/projects/unpolarize/knowledge-planning",
  };

  it("dash-encodes every non-alphanumeric the way Claude names storage dirs", () => {
    expect(dashEncodeCwd("/Users/me/projects/foo.bar")).toBe("-Users-me-projects-foo-bar");
    expect(dashEncodeCwd("/Users/me/00_project x")).toBe("-Users-me-00-project-x");
  });

  it("claude sessions match via encoded storage-dir basename; others via real cwd", () => {
    expect(sessionMatchesWorkspace(claudeSession, ws)).toBe(true);
    expect(sessionMatchesWorkspace(codexSession, ws)).toBe(true);
    expect(sessionMatchesWorkspace(codexSession, ws + "/")).toBe(true);
    expect(sessionMatchesWorkspace(grokOther, ws)).toBe(false);
    expect(
      sessionMatchesWorkspace(claudeSession, "/Users/me/projects/unpolarize/knowledge-planning")
    ).toBe(false);
  });

  it("subagent/workflow children ride along only when their parent matched", () => {
    const child: JoinableSession = {
      session_id: "c1__subagent__abc",
      source: "claude",
      project_path: claudeSession.project_path,
      kind: "subagent",
      parent_session_id: "c1",
    };
    const orphan: JoinableSession = { ...child, session_id: "zz", parent_session_id: "gone" };
    const got = filterWorkspaceSessions([claudeSession, codexSession, grokOther, child, orphan], ws);
    expect(got.map((s) => s.session_id).sort()).toEqual(["c1", "c1__subagent__abc", "x1"]);
  });
});

describe("buildDoctorReport + exportChecklist", () => {
  it("buckets candidates / protected / unscorable / scored and exports a hedged checklist", () => {
    const sections: RuleSection[] = [
      section("Always run `npm run compile` first.", "Build", "CLAUDE.md"),
      section("Consult `docs/nonexistent-ritual.md` weekly.", "Rituals", "CLAUDE.md"),
      section("- Never push directly to main", "Safety", "AGENTS.md"),
      section("", "Testing", "AGENTS.md"),
    ];
    const turns = [{ sessionId: "s1", text: "running npm run compile now" }];
    const report = buildDoctorReport(sections, turns, 30);

    expect(report.scoredWithHits.map((s) => s.heading)).toEqual(["Build"]);
    expect(report.candidates.map((s) => s.heading)).toEqual(["Rituals"]);
    expect(report.protected.map((s) => s.heading)).toEqual(["Safety"]);
    expect(report.unscorable.map((s) => s.heading)).toEqual(["Testing"]);

    const md = exportChecklist(report);
    expect(md).toContain("- [ ] CLAUDE.md › Rituals");
    expect(md).toContain("No transcript evidence in the last 30");
    expect(md).not.toContain("Safety"); // protected stays off the checklist
    expect(md).not.toMatch(/delete these/i);
  });
});

describe("runRulesDoctor + renderDoctorCardHtml", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rules-doctor-run-"));
    fs.writeFileSync(
      path.join(root, "AGENTS.md"),
      [
        "## Build",
        "",
        "Always run `npm run compile` first.",
        "",
        "## Dead ritual",
        "",
        "Consult `docs/nonexistent-ritual.md` weekly.",
        "",
        "## Safety",
        "",
        "- Never push directly to main",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function fakeStore(opts?: {
    sessions?: Array<JoinableSession & { mtime_ns: number; ended_at?: number | null }>;
    turns?: Record<string, Array<{ user_text: string | null; assistant_full: string | null; assistant_excerpt: string | null }>>;
  }): DoctorTurnSource {
    const sessions = opts?.sessions ?? [
      {
        session_id: "s1",
        source: "codex",
        project_path: root,
        kind: "session",
        mtime_ns: 1_700_000_000_000_000_000,
        ended_at: Date.parse("2026-08-20T12:00:00Z"),
      },
    ];
    const turns = opts?.turns ?? {
      s1: [
        {
          user_text: "please run npm run compile",
          assistant_full: "running npm run compile now",
          assistant_excerpt: null,
        },
      ],
    };
    return {
      listRecent: () => sessions,
      turnsForSession: (id) => turns[id] ?? [],
    };
  }

  it("scores live phrases, candidates zero-hit sections, and protects Never lines", () => {
    const result = runRulesDoctor(root, fakeStore(), 30);
    expect(result.emptyReason).toBeUndefined();
    expect(result.report.sessionCount).toBe(1);
    expect(result.report.scoredWithHits.map((s) => s.heading)).toContain("Build");
    expect(result.report.candidates.map((s) => s.heading)).toContain("Dead ritual");
    expect(result.report.protected.map((s) => s.heading)).toContain("Safety");
    expect(result.windowStart).toBe("2026-08-20");
  });

  it("empty-reason paths: no store / no rules / no sessions", () => {
    expect(runRulesDoctor(root, null).emptyReason).toBe("no-store");
    expect(runRulesDoctor("", fakeStore()).emptyReason).toBe("no-workspace");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "rules-doctor-empty-"));
    try {
      expect(runRulesDoctor(other, fakeStore()).emptyReason).toBe("no-rules");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    const noMatch = fakeStore({
      sessions: [
        {
          session_id: "z",
          source: "codex",
          project_path: "/somewhere/else",
          kind: "session",
          mtime_ns: 1,
          ended_at: null,
        },
      ],
    });
    expect(runRulesDoctor(root, noMatch).emptyReason).toBe("no-sessions");
  });

  it("renders 4 buckets + disclaimer + command URIs (never 'delete')", () => {
    const result = runRulesDoctor(root, fakeStore(), 30);
    const html = renderDoctorCardHtml(result);
    expect(html).toContain("Candidates — no transcript evidence");
    expect(html).toContain("Protected — short Never/Do-not shields");
    expect(html).toContain("Unscorable — no distinctive signal");
    expect(html).toContain("Scored with hits");
    expect(html).toContain("command:codeSessions.openRulesDoctorSection?");
    expect(html).toContain("command:codeSessions.copyRulesDoctorChecklist?");
    expect(html).toContain("silent compliance");
    expect(html).not.toMatch(/delete these/i);
    expect(html).toContain("Dead ritual");
    expect(html).toContain("Build");
  });

  it("can omit command URIs for non-webview callers", () => {
    const result = runRulesDoctor(root, fakeStore(), 30);
    const html = renderDoctorCardHtml(result, { commandUris: false });
    expect(html).not.toContain("command:codeSessions");
  });
});
