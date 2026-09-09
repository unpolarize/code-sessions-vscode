// Effort-drift canary harness — static fixture matching renderEffortDriftCardHtml
// output for the Fable high→low collapse case. Clicks on command: links are
// captured in window.__clicks (VS Code would dispatch the command URI).

window.__clicks = [];

function log() {
  const el = document.getElementById("log");
  if (el) el.textContent = "clicks: " + JSON.stringify(window.__clicks, null, 2);
}

// Fixture HTML mirrors src/effortDriftCanary.ts renderEffortDriftCardHtml for
// the collapse fixture (schema + drifted rows + pin + session deep-link).
const FIXTURE = `
<section class="edc-card" data-schema="code-sessions/effort-drift-canary@1" data-level="drift">
  <div class="edc-head"><span class="edc-title">Effort drift canary</span><span class="edc-level edc-warn">drift</span></div>
  <div class="edc-sub">"high" on claude-fable-5 is behaving like a lower effort tier</div>
  <div class="edc-detail">claude: tokens/turn is 0.15x the 7-day baseline (3/3 metrics drifted, 6 baseline / 1 today sessions). Possible silent effort-label remap — verify before trusting "high".</div>
  <table class="edc-table"><tr><th></th><th>baseline</th><th>today</th><th>ratio</th></tr>
    <tr class="edc-drifted"><th>tokens/turn</th><td>2000</td><td>300</td><td>0.15x</td></tr>
    <tr class="edc-drifted"><th>tool calls/turn</th><td>3.0</td><td>0.8</td><td>0.27x</td></tr>
    <tr class="edc-drifted"><th>wall time/turn</th><td>40.0s</td><td>9.0s</td><td>0.23x</td></tr>
  </table>
  <div class="edc-sessions">Sessions: <a class="edc-session" href="command:codeSessions.openSession?%5B%22today-0%22%5D">today-0</a></div>
  <div class="edc-actions"><a class="edc-btn" href="command:codeSessions.effortDrift.pinSemantics?%5B%22claude%22%2C%22claude-fable-5%22%2C%22high%22%5D" title="Record expected semantics for this label as a KP/doctor note">Pin expected semantics</a></div>
</section>
<div class="edc-disclaimer">Advisory only — compares today's per-turn tokens / tool calls / wall time for the same backend+model+effort label against a rolling 7-day median. Does not auto-switch models. Motivating case: silent Fable high→low effort remap.</div>
`;

document.getElementById("root").innerHTML = FIXTURE;

document.getElementById("root").addEventListener("click", (ev) => {
  const a = ev.target && ev.target.closest ? ev.target.closest("a[href^='command:']") : null;
  if (!a) return;
  ev.preventDefault();
  const href = a.getAttribute("href") || "";
  window.__clicks.push({ href, text: (a.textContent || "").trim() });
  log();
});

log();
