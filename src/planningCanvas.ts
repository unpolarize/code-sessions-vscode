// Excalidraw visual canvas for the planning system.
//
// Loads the official Excalidraw UMD bundle (React + ReactDOM + @excalidraw/excalidraw,
// all vendored into media/canvas/ — offline, no bundler) in a webview, with
// EXCALIDRAW_ASSET_PATH pointed at the vendored fonts. The scene is persisted to the
// planning store at <storeRoot>/canvas/board.excalidraw (JSON), so it lives in git with
// the rest of the plan. A small glue script (media/canvas/mount.js) mounts Excalidraw and
// debounces saves back to the host.

import * as vscode from "vscode";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

let current: vscode.WebviewPanel | undefined;

function nonce(): string {
  let s = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export function openCanvas(ctx: vscode.ExtensionContext, storeRoot: string, sceneName = "board"): void {
  if (current) {
    current.reveal();
    return;
  }
  const mediaRoot = vscode.Uri.joinPath(ctx.extensionUri, "media", "canvas");
  const panel = vscode.window.createWebviewPanel("codePlanningCanvas", "Planning Canvas", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaRoot],
  });
  current = panel;
  panel.onDidDispose(() => (current = undefined));

  const sceneFile = path.join(storeRoot, "canvas", `${sceneName}.excalidraw`);

  panel.webview.onDidReceiveMessage((m: { type: string; scene?: unknown }) => {
    if (m.type === "ready") {
      let scene: unknown = { type: "excalidraw", version: 2, elements: [], appState: {} };
      if (existsSync(sceneFile)) {
        try {
          scene = JSON.parse(readFileSync(sceneFile, "utf8"));
        } catch {
          /* corrupt scene → start blank */
        }
      }
      panel.webview.postMessage({ type: "load", scene });
    } else if (m.type === "save" && m.scene) {
      try {
        mkdirSync(path.dirname(sceneFile), { recursive: true });
        writeFileSync(sceneFile, JSON.stringify(m.scene, null, 2), "utf8");
      } catch (e) {
        void vscode.window.showWarningMessage(`Planning canvas save failed: ${(e as Error).message}`);
      }
    }
  });

  const uri = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f)).toString();
  const assetPath = panel.webview.asWebviewUri(mediaRoot).toString() + "/";
  const cs = panel.webview.cspSource;
  const n = nonce();
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${n}' ${cs} 'unsafe-eval'; style-src 'unsafe-inline' ${cs}; font-src ${cs} data:; img-src ${cs} data: blob:; connect-src ${cs} data: blob:; worker-src blob: ${cs}; child-src blob:;">
<style>html,body,#root{height:100%;width:100%;margin:0;padding:0}#root{position:absolute;inset:0}</style>
</head><body>
<div id="root"></div>
<script nonce="${n}">
  window.process = window.process || { env: { NODE_ENV: "production" } };
  window.EXCALIDRAW_ASSET_PATH = ${JSON.stringify(assetPath)};
</script>
<script nonce="${n}" src="${uri("react.js")}"></script>
<script nonce="${n}" src="${uri("react-dom.js")}"></script>
<script nonce="${n}" src="${uri("excalidraw.js")}"></script>
<script nonce="${n}" src="${uri("mount.js")}"></script>
</body></html>`;
}
