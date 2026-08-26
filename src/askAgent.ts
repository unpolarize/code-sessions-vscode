// Host-side Ask runtime: pick backend + model the way Code Build's header
// does, then run a one-shot `claude -p` / `grok -p`.
import { execFile } from "node:child_process";
import * as vscode from "vscode";

export type AskBackend = "claude" | "grok";

const MODELS: Record<AskBackend, { label: string; models: { id: string; label: string }[] }> = {
  claude: {
    label: "Claude Code",
    models: [
      { id: "sonnet", label: "sonnet (default)" },
      { id: "opus", label: "opus" },
      { id: "haiku", label: "haiku" },
      { id: "fable", label: "fable" },
    ],
  },
  grok: {
    label: "Grok Build",
    models: [
      { id: "grok-4.6", label: "grok-4.6 (default)" },
      { id: "grok-4.5", label: "grok-4.5" },
    ],
  },
};

export async function pickAskRuntime(): Promise<{ backend: AskBackend; model: string } | undefined> {
  const backendPick = await vscode.window.showQuickPick(
    [
      { label: "$(hubot) Claude Code", description: "claude -p", backend: "claude" as const },
      { label: "$(rocket) Grok Build", description: "grok -p", backend: "grok" as const },
    ],
    { title: "Ask — provider", placeHolder: "Same backends as Code Build" },
  );
  if (!backendPick) return undefined;
  const spec = MODELS[backendPick.backend];
  const modelPick = await vscode.window.showQuickPick(
    spec.models.map((m) => ({ label: m.label, model: m.id })),
    { title: `Ask — ${spec.label} model`, placeHolder: "Model" },
  );
  if (!modelPick) return undefined;
  return { backend: backendPick.backend, model: modelPick.model };
}

export function askArgv(backend: AskBackend, model: string, prompt: string): { bin: string; args: string[] } {
  if (backend === "grok") return { bin: "grok", args: ["-p", prompt, "--model", model] };
  return { bin: "claude", args: ["-p", prompt, "--model", model, "--output-format", "text"] };
}

export function invokeAskAgent(
  prompt: string,
  opts: { backend: AskBackend; model: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const { bin, args } = askArgv(opts.backend, opts.model, prompt);
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ANTHROPIC_API_KEY: opts.backend === "claude" ? "" : process.env.ANTHROPIC_API_KEY },
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    child.on("error", () => resolve({ stdout: "", stderr: `failed to spawn ${bin}`, code: 1 }));
  });
}
