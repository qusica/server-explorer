# WebView2 package-size experiment

This is **an incomplete prototype**, not a replacement for the Electron desktop app yet.

## Intent

Replace Electron's bundled Chromium with the Windows Evergreen WebView2 runtime, while preserving the existing Node.js OpenSSH/SFTP backend and the vanilla HTML/CSS/JavaScript UI.

- Host: `webview2/ServerExplorer` (WinForms / .NET 8, framework-dependent)
- Backend: `src/service.js` (Node 22 subprocess using newline-delimited JSON on stdio)
- Frontend bridge: `src/renderer/webview2-bridge.js`
- CI: `.github/workflows/webview2.yml`; manual workflow dispatch also supported.

## Build

On Windows, install .NET 8 SDK, Node 22 and npm. From a checkout:

```powershell
npm ci
node scripts/build-askpass.js
dotnet publish webview2/ServerExplorer/ServerExplorer.csproj -c Release -r win-x64 --self-contained false
```

For the **complete** distributable, use the WebView2 size experiment GitHub workflow. It collects the host, Node runtime, production dependencies, HTML/CSS/JS, backend, and authentication helper as a ZIP.

The prototype requires **both** the .NET 8 Desktop Runtime and Microsoft Edge WebView2 Evergreen Runtime on the end user's Windows machine. These are **not** embedded in the ZIP and should be counted separately when comparing installations or offline deployment.

## Known incomplete functionality

- Dragging local files from Windows Explorer into WebView2 lacks an equivalent to Electron `webUtils.getPathForFile`. The current fallback returns an empty path.
- Dragging remote files out to Explorer lacks a replacement for Electron's `webContents.startDrag` and does not perform an OLE drag operation.
- Exiting while transfers are running has no user confirmation and needs to preserve cleanup behavior.
- Windows-specific end-to-end UI tests are not ported from Electron/Playwright yet.
- No measured size reduction can be claimed until the CI builds successfully and generates the ZIP; the existing v1.0.6 Electron portable EXE is **100,482,956 bytes**.

Do not release or merge this experiment as a complete feature-parity port until these are resolved.
