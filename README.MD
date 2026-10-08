# GrabThatMesh

A lightweight browser extension that saves GLB models and PNG textures captured while the [Meshy](https://www.meshy.ai/) 3D viewer loads them.

GrabThatMesh runs locally in your browser and provides two download controls: an extension popup and a draggable button on the page. It requires no build step, account of its own, or external backend.

The interface, status messages, and download controls are in English.

## Features

- **GLB capture:** Saves supported model data returned by the viewer's loader worker.
- **Texture capture:** Collects PNG files fetched from Meshy's asset host.
- **Two download controls:** Download from the extension popup or the floating page button.
- **Separate document caches:** Keeps captured files separate across tabs and page reloads, and resets the current capture when the page URL changes.
- **Accessible controls:** Includes keyboard activation, status announcements in the popup, and reduced-motion support.
- **Local processing:** Handles captured files in browser memory and IndexedDB without uploading them to an extension-operated service.

## Requirements

- A Chromium-based browser with Manifest V3 support, such as Chrome, Edge, or Brave.
- A model page at `https://www.meshy.ai/` that loads through the supported viewer workflow.
- Node.js 20 or newer only if you want to run the development tests.

Compatibility depends on the viewer's implementation. Changes to Meshy's worker messages or asset-loading behavior may require extension updates.

## Installation

1. Download the project source and extract it to a local folder.
2. Open your browser's extensions page:

   | Browser | Extensions page |
   | --- | --- |
   | Chrome | `chrome://extensions` |
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |

3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the folder containing `manifest.json`.
5. Reload any Meshy tabs that were open before installation.

No dependency installation or compilation is required.

## Usage

1. Open a model page on [Meshy](https://www.meshy.ai/).
2. Wait for the 3D viewer to load the model. The floating button updates when a supported GLB is captured.
3. Click the floating **Download** button, or open the extension popup and select **Download all**.
4. Check your browser's downloads for the GLB and any captured PNG textures.

The extension downloads files separately. If your browser prompts you to allow multiple downloads, allow them to save the textures alongside the model.

Drag the floating button to reposition it. Its position is saved locally, and dragging it does not start a download.

## How it works

The extension runs in the page's main JavaScript context at document start. It listens for successful model-processing messages from the viewer's `loader-worker`, checks the GLB header, and copies the returned model buffer. It also observes page-level `fetch` responses for PNG files from `assets.meshy.ai`.

Captured data is kept in memory and cached in the site's IndexedDB under a document-specific identifier. The popup reads that cache to display available files and initiate downloads. Cache entries older than 24 hours are removed when another Meshy document loads.

The extension captures model data that the viewer has already processed; it does not implement a separate decryption engine.

### Capture limits

- Only the supported worker-message format and GLB version 2 headers are recognized.
- Separate texture capture covers PNG responses observed through page-level `fetch`. It does not cover every image format or loading mechanism.
- Texture files are collected from observed requests; the extension does not verify their material assignments or package them with the model.
- Navigating to another page URL clears the current in-memory capture. Previously captured models are not presented as a download history.
- Download status indicates that downloads were initiated, not that the browser finished saving every file.

## Permissions and local storage

| Permission or storage | Purpose |
| --- | --- |
| `scripting` | Lets the popup run cache-reading and download code in the active Meshy page. |
| `activeTab` | Allows interaction with the active tab when you use the extension. |
| `https://www.meshy.ai/*` | Limits the configured host access and automatic content-script injection to this site. |
| IndexedDB | Stores captured model and texture data for the popup. |
| Local storage | Remembers the floating button's position. |

Captured files are stored within the Meshy site's browser storage, rather than a private extension storage area. The extension includes no analytics or external upload service.

## Troubleshooting

| Issue | What to check |
| --- | --- |
| The extension is waiting for a model | Reload the Meshy page after installing or updating the extension, then let the viewer finish loading. The current viewer workflow may also be unsupported. |
| The popup reports that the page is unsupported | Open a model on `https://www.meshy.ai/`. Other domains and subdomains are not configured. |
| The model downloads but textures are missing | Wait for texture requests to finish and allow multiple downloads in the browser. Only captured PNG files are included. |
| The popup reports a storage error | Reload the page and check whether site storage is available. The floating button can still save a model already held in memory. |
| The model changes before a download starts | Wait for the popup to refresh, then try again. |
| A code change has no effect | Reload the extension on the browser's extensions page, then reload the Meshy tab. |

## Development

The project uses plain JavaScript and HTML with no build tooling or runtime dependencies.

```text
.
├── content.js                 # Model capture, texture capture, cache, and floating control
├── LICENSE                    # MIT license
├── manifest.json              # Extension configuration and permissions
├── popup.html                 # Popup layout and styles
├── popup.js                   # Popup state, cache access, and download handling
├── icon.png                   # Extension icon
└── tests/
    └── extension.test.cjs      # Regression tests using browser mocks
```

Run the regression suite from the project directory:

```bash
node --test tests/extension.test.cjs
```

The suite covers worker event behavior, GLB header validation, document isolation, navigation resets, texture interception, popup rendering, download errors, and floating-button interactions.

The tests use browser mocks and do not establish compatibility with the live Meshy viewer. Before submitting a change, also check the extension in a browser:

1. Load different models in two Meshy tabs and verify each tab shows its own captured files.
2. Navigate between model pages and confirm that stale download controls reset.
3. Download through both the popup and the floating button.
4. Drag the floating button, then activate it with the keyboard.
5. Inspect browser downloads and the console for unexpected failures.

## Contributing

Bug reports and pull requests are welcome. When reporting an issue, include your browser version, steps to reproduce it, expected and actual behavior, and relevant console errors. Remove credentials, signed asset URLs, and private model data from reports.

Keep changes focused, add regression coverage for behavior changes, and describe any manual browser checks performed.

## Responsible use

Use GrabThatMesh only with assets you own or are authorized to download. This project does not grant rights to captured models or textures; follow the terms and licensing that apply to those assets.

GrabThatMesh is an independent project and is not affiliated with or endorsed by Meshy.

## License

This project is licensed under the [MIT License](LICENSE).
