# ComfyUI PSD Figure Creator

**Language / 言語 / 语言:** English | [日本語](README.ja.md) | [中文](README.zh.md)

A ComfyUI custom node for loading PSD files, rigging layers with interactive control points,
and compositing the result as `IMAGE` + `MASK` outputs.

---

## Features

- **Interactive layer viewer** — toggle visibility, rename layers and custom groups
- **Custom groups** — bundle layers into named groups; drag to reorder draw order
- **Rigging system** — place control points on layers directly on the canvas:
  - **R** (blue) — rotation only
  - **MR** (red/orange) — move + rotate
  - **SW** (green) — switch: rotate a handle to step through up to 12 slots; use **+L** to add an individual layer (1 slot), **+P** to add a group/folder expanded per-layer (Piece, N slots), or **+C** to add a group/folder composited as one (Composite, 1 slot)
- **Setup mode / Pose mode** — configure rigs in setup mode, animate in pose mode
- **Library** — save/load named model files (`.psd-model.json`) and pose files
- **Background options** — checker pattern / solid color / local image / upstream `IMAGE` node
- **Capture → Queue Prompt** — bake the current canvas state to an output image
- **i18n** — UI language auto-detected from `navigator.language` (Japanese / English / Simplified Chinese)

---

## Screenshots

### Node

![Node overview](docs/1_node.png)

### Editor — Layers tab (Setup mode)

![Layers tab with MR point placement](docs/2_setup_layers.png)

### Editor — Parent tab

![Parent tab with full rig labels](docs/3_setup_parent.png)

### Editor — Switch tab

![Switch tab with SW point configuration](docs/4_setup_switch.png)

### Node preview — rig complete

![Node preview showing all rig points](docs/5_setup_complete.png)

### Library — model & pose browser

![Library panel](docs/6_library.png)

### Capture in a ComfyUI workflow

![Capture used inside a workflow](docs/7_capture.png)

---

## Installation

```bash
# 1. Copy or symlink this folder into ComfyUI's custom_nodes directory
#    e.g. ComfyUI/custom_nodes/psd-image-loader/

# 2. Install the Python dependency
pip install psd-tools
```

Restart ComfyUI. The node appears under **image/psd → PSD Figure Creator**.

---

## Sample Data

A ready-to-use sample is bundled in the `user_data/` directory:

| File | Description |
|---|---|
| `user_data/sample_1.psd` | Sample character PSD |
| `user_data/models/sample.psd-model.json` | Pre-configured rig (R/MR points, parent hierarchy, SW switch) |
| `user_data/poses/pose1.pose.json` | Sample pose 1 |
| `user_data/poses/pose2.pose.json` | Sample pose 2 |

**To use the sample:**
1. Copy `user_data/sample_1.psd` to `ComfyUI/input/psd/`
2. Open the **Editor** and click **📂 model** — `sample` will appear in the library
3. Load the model; sample poses are available in the pose library

> **Upgrading from PSD Loader (≤ v2.16):**  
> If your workflow JSON contains `"PSDLoader"`, replace it with `"PSDFigureCreator"`.

---

## Node Inputs & Outputs

| Parameter | Type | Description |
|---|---|---|
| `psd_filename` | STRING | PSD file path relative to the `input/psd/` directory |
| `layer_config` | STRING | JSON string produced by the UI editor |
| `output_width` | INT | Output width in pixels (0 = native PSD size) |
| `output_height` | INT | Output height in pixels (0 = native PSD size) |
| `image_data` | STRING | Base64 PNG from Capture (bypasses server-side compositing) |
| `background_image` | IMAGE | Optional upstream image composited as the bottom layer |

| Output | Type | Description |
|---|---|---|
| `image` | IMAGE | Composited RGB image |
| `mask` | MASK | Alpha channel |

---

## UI Overview

```
[✨ New] [📂 PSD file]  [⟳]
[Editor]               [RC]
[📸 Capture]
 ┌────────────────────────┐
 │  Preview canvas        │
 └────────────────────────┘
 Point Size: ─────────────
 BG: [■ color][✕] [🖼 Image][✕] [🔗 Connected?]
```

- **Editor** — opens the full-screen setup/pose modal
- **RC** — reset camera (pan + zoom)
- **✨ New** — clears all rigging, SW layers, and poses (prompts for confirmation)

### Setup modal tabs

| Tab | Contents |
|---|---|
| Layers | Layer tree, custom group management, rig mode buttons (R / MR / SW) |
| Parent | Parent–child hierarchy for propagated transforms |
| Switch | SW layer list and group-slot editor |

---

## Rig System

### R — Rotation
Blue dot. Drag in pose mode to rotate the layer around the placed pivot.

### MR — Move + Rotate
Red origin + orange handle. Drag the handle to move and rotate simultaneously.

### SW — Switch
Green origin + cyan handle. Rotating the handle steps through registered slots in 30° increments (maximum 12 slots × 30° = 360°).  
Drag the origin in setup mode to reposition; drag the handle to adjust radius and initial angle.

**Slot entry types** (configured in the Switch tab):

| Button | Entry | Badge | Slots |
|---|---|---|---|
| `+L` | Individual PSD layer | `[L]` | 1 slot |
| `+P` | Custom group or PSD folder (Piece) | `[P]` | 1 slot per member / leaf layer |
| `+C` | Custom group or PSD folder (Composite) | `[C]` | 1 slot (all members rendered together) |

A slot entry whose group or folder has been deleted shows a red row background and a ⚠ icon (orphaned). Delete it manually before adding new entries.

---

## Clipping Layers

Layers with the Photoshop "clip to layer below" flag appear with a **✂** badge in the layer panel and SW `+L` dropdown. The canvas compositor renders them using `source-atop` blending: each clipping layer is masked to the opaque area of its base layer (the layer directly below it). R/MR rigs placed on a clipping layer work normally within that masked region.

> **⚠ Parent setup note:** If the base layer has a rig that moves it, the clipping layer must share the **same parent** (configured in the Parent tab) to follow along. Without a matching parent, the clipping layer stays at its original canvas position while the base moves, breaking the mask alignment.

---

## Background Priority

Highest to lowest:

1. **ComfyUI `background_image` input** — server-side composite (letterbox, aspect-ratio preserved)
2. **Local background image** — loaded via the `🖼 Image` button, rendered client-side
3. **Background color** — solid fill selected with the color picker
4. **Checker pattern** — default transparent background indicator

---

## File Structure

```
psd-image-loader/
├── __init__.py              # Node registration
├── psd_loader_node.py       # PSDFigureCreatorNode
├── psd_utils.py             # psd-tools compositing helpers
├── server.py                # aiohttp API routes (upload / layers / preview / library)
├── requirements.txt
└── web/
    ├── js/
    │   ├── psd_loader.js    # Front-end (canvas, modal, rigging)
    │   └── i18n.js          # Translation dictionaries + t() helper
    └── css/
        └── psd_loader.css
```

---

## layer_config Schema

```jsonc
{
  "visibility":    { "<layerId>": true | false },
  "renamed":       { "<layerId>": "display name" },
  "custom_groups": [{ "name": "...", "layer_ids": [...], "visible": true }],
  "layer_order":   [{ "id": "...", "children": [...] }],
  "rigging": {
    "<layerId>": {
      "r":         { "x": 0, "y": 0 },
      "mr":        { "x": 0, "y": 0 },
      "mr_radius": 40
    }
  },
  "pose": {
    "<layerId>": { "angle": 0, "tx": 0, "ty": 0 }
  },
  "sw_layers": [{
    "id": "...", "name": "sw1",
    "points": [{
      "id": "...", "name": "pt1",
      "x": 512, "y": 512,
      "radius": 60, "angle": 0,
      "groups": [
        "<layerId>",                                              // +L — individual layer, 1 slot
        { "type": "custom_group", "id": "...", "mode": "piece" },     // +P — 1 slot per member layer
        { "type": "psd_group",    "id": "...", "mode": "composite" }  // +C — 1 slot (composited)
        // mode defaults to "piece" when omitted (backward compatible)
      ]
    }]
  }]
}
```

---

## Requirements

- **ComfyUI** (latest)
- **Python 3.10+**
- **psd-tools ≥ 1.9.0**

---

## License

MIT
