// Glue: mount Excalidraw (from the UMD global ExcalidrawLib) and sync the scene with
// the extension host. Load order (set by planningCanvas.ts): react → react-dom →
// excalidraw → this file.
(function () {
  var vscode = acquireVsCodeApi();
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var Excalidraw = window.ExcalidrawLib && window.ExcalidrawLib.Excalidraw;
  var rootEl = document.getElementById("root");

  if (!React || !ReactDOM || !Excalidraw) {
    rootEl.innerHTML =
      '<div style="padding:20px;color:#e51400;font-family:sans-serif">Excalidraw failed to load (React/ExcalidrawLib missing). Check the webview console.</div>';
    return;
  }

  var saveTimer = null;
  function App() {
    var state = React.useState(null);
    var data = state[0];
    var setData = state[1];

    React.useEffect(function () {
      function onMsg(e) {
        var m = e.data;
        if (m && m.type === "load") setData(m.scene || { elements: [], appState: {} });
      }
      window.addEventListener("message", onMsg);
      vscode.postMessage({ type: "ready" });
      return function () {
        window.removeEventListener("message", onMsg);
      };
    }, []);

    function onChange(elements, appState) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        vscode.postMessage({
          type: "save",
          scene: {
            type: "excalidraw",
            version: 2,
            source: "code-sessions-planning",
            elements: elements,
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              gridSize: appState.gridSize,
            },
          },
        });
      }, 700);
    }

    if (data === null) {
      return React.createElement("div", { style: { padding: "20px", color: "#bbb", fontFamily: "sans-serif" } }, "Loading canvas…");
    }
    return React.createElement(
      "div",
      { style: { position: "absolute", inset: 0 } },
      React.createElement(Excalidraw, { initialData: data, onChange: onChange, theme: "dark" })
    );
  }

  ReactDOM.createRoot(rootEl).render(React.createElement(App));
})();
