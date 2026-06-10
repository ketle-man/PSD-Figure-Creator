# Development Log — ComfyUI PSD Figure Creator

---

## v2.24.0 — 2026-06-10

### Overview
Post-release code review of the v2.21–v2.23 work (clipping-mask support, +L/+P/+C split)
surfaced nine findings; eight are fixed here. The ninth — in-place entry-type conversion
between layer and group entries, removed by the +L/+P/+C dropdown split — is accepted as a
design tradeoff. Highlights: clipping stacks now work at the document root and inside
custom groups (previously only inside PSD folders), layer masks are applied again in
canvas layer images, hidden clipping layers are respected by server-side compositing, and
the clipping-stack offscreen canvas is cached instead of re-allocated per frame.
Additionally, the output-size widgets now step in 1 px increments.

### Fixed
- **Root-level / custom-group clipping stacks** (`psd_loader.js`) — clipping stacks were
  only assembled by `renderChildren`, which is reached exclusively for PSD folder children.
  Root-level layers (both the `cg_order` path and the PSD-order fallback) and custom-group
  members were drawn one-by-one via `renderOneNode` / `renderCg`, so clipping layers
  outside folders rendered unclipped (fully visible). New helper
  `renderIdList(ids, skipCgMembers, skipCgMemberEntries)` groups consecutive plain nodes
  into runs and feeds them through `renderChildren`, so stacks form on every path:
  - `cg_order` path → `renderIdList([...cgOrder].reverse(), true, true)`
  - `renderCg` (custom-group members) → `renderIdList([...cg.layer_ids].reverse(), false, false)`
  - fallback path → `renderChildren(layers, false)` directly
  - `renderClippingStack` also gained the previously missing
    `skipCgMembers && cgMemberIds.has(base.id)` guard on the base layer, matching
    `renderOneNode` behavior.

- **Hidden clipping layers baked into server-side composite** (`psd_utils.py`) —
  `_manual_composite` / `_manual_composite_ordered` skipped clipping layers *before*
  consulting `effective_vis`, and the base layer's `composite()` bakes clip layers in
  regardless of config — so a clipping layer hidden in the UI still appeared in
  `/psd_loader/preview` output (JS preview hid it correctly). Base composition now passes
  a `layer_filter` built from `effective_vis` (`_composite_single(layer, vis_fn)`), so
  hidden clipping layers are excluded. psd-tools without `layer_filter` support falls back
  to the previous behavior via `TypeError` catch.

- **Layer masks lost in canvas layer images** (`psd_utils.py::get_layer_image_by_id`) —
  v2.21 switched to `topil()` to avoid clip-layer double-draw, but `topil()` returns raw
  pixels without layer masks, effects, or opacity. Now uses
  `composite(layer_filter=lambda l: l is current)`, which applies masks while still
  excluding clipping layers. For clipping layers themselves, a solo composite produces a
  fully transparent image (nothing to clip to) — fixed by temporarily clearing the
  `clipping` flag during composite (restored in `finally`; verified alpha-identical to
  `topil()` on the sample PSD).

### Performance
- **Offscreen canvas cached** (`psd_loader.js`) — `renderClippingStack` allocated a
  full-size `document.createElement('canvas')` per clipping stack per render pass;
  `_drawPreview` runs on every mousemove during pose dragging, so this caused GC churn and
  frame drops. The canvas is now cached in module-scope `_clipTmpCanvas`, resized only when
  dimensions change, and cleared with `clearRect` per use.

### Changed
- **`output_width` / `output_height` step 64 → 1** (`psd_loader_node.py`) — output size is
  now adjustable in 1 px increments (drag/arrow steps; was jumping by 64).
- **`countSwSlots` = `expandSwGroupEntries().length`** (`psd_loader.js`) — removed the
  duplicated composite/piece counting logic; slot expansion now has a single source of
  truth (verified equivalent across 7 entry-type cases).
- **`isOrphaned` simplified** (`_renderSwitchTab`) — the composite/piece ternary collapsed
  to `(isPsdGroup || isCustomGroup) && (leaves?.length ?? 0) === 0`, which is equivalent
  for both modes.
- **`server.py::_build_layer_tree` delegates to `psd_utils.get_layer_tree`** — removed the
  duplicated layer-dict construction (the two copies had to be edited in lockstep, e.g.
  the v2.21 `clipping` field). Output verified identical.
- **`_paste_layer` helper extracted** (`psd_utils.py`) — the identical composite→RGBA→
  bounds-check→paste block in `_manual_composite` and `_manual_composite_ordered` is now
  shared.
- **Error logging** — the bare `except Exception: pass` around the layer-image composite
  now logs `[psd_figure_creator] layer composite error (<name>): <e>` instead of silently
  swallowing corrupt-layer failures.
- **Dead i18n key removed** — `addGroupTooltip` (ja/en/zh) had no remaining references
  after the v2.20 +L/+P/+C button split.

### Verification
- Python (sample_1.psd): hiding clipping layer `6.1` (irides-r) now changes both manual
  composite paths (3,360 px diff, matching the layer bbox); all-visible output is
  byte-identical before/after; `get_layer_image_by_id` returns mask-applied, clip-free
  base images and non-empty clip-layer images.
- JS (stub-DOM harness, 9 tests): clipping stacks form on root fallback / `cg_order` /
  custom-group paths; `source-atop` draw order preserved; visibility overrides respected;
  canvas cache allocates once; `countSwSlots` equivalence; non-clipping layers still draw
  directly to the main canvas.

---

## v2.23.0 — 2026-06-07

### Overview
Bundled a sample character PSD with a pre-configured model and two pose files so users can
try the rigging system immediately after installation.

### Added
- **`user_data/sample_1.psd`** — sample character PSD (~2.3 MB).
- **`user_data/models/sample.psd-model.json`** — fully configured model for `sample_1.psd`:
  - R pivots on layers 2, 3, 4, 11
  - MR points on layers 0, 1, 5, 9, 10, and sub-layers 6.1 / 7.1
  - Parent hierarchy: layer 2 as root → 3 → 4 → children (eyes, mouth, accessories, etc.)
  - SW layer `SW1` with a composite-mode slot referencing group 7 and leaf layer 8
- **`user_data/poses/pose1.pose.json`** — sample pose 1 (head tilt + eye/mouth movement).
- **`user_data/poses/pose2.pose.json`** — sample pose 2 (alternate expression).

### Notes
- `user_data/models/` and `user_data/poses/` are loaded automatically by the library panel.
- `user_data/sample_1.psd` must be copied to `ComfyUI/input/psd/` manually before the model
  can be loaded (the model JSON references `psd_filename: "sample_1.psd"`).

---

## v2.22.0 — 2026-06-07

### Overview
Two maintenance fixes: a DOM crash in inline-rename handlers, and a help-dialog gap where
the Chinese Parent Tab section was missing entirely and all three languages lacked the
clipping-layer caveat for parent setup.

### Fixed
- **Inline rename `replaceWith` crash** (`psd_loader.js`) — Four inline-rename handlers
  (SW point name, custom-group name, SW layer name, `_inlineRename`) all shared the same
  pattern: `nameEl.replaceWith(input)` on double-click, then `input.replaceWith(nameEl)` in
  `commit()`. Pressing Enter called `commit()` which removed `input` from the DOM, then the
  resulting `blur` event fired `commit()` a second time, causing
  `NotFoundError: Failed to execute 'replaceWith' on 'Element'`. Fixed by adding
  `if (!input.isConnected) return;` at the top of every `commit` closure — idempotent once
  the input is detached.

### Changed
- **Help dialog — Parent Tab** (`_showHelp` in `psd_loader.js`):
  - Added `⚠ クリッピングレイヤー` row to the Japanese **ペアレントタブ** section.
  - Added `⚠ Clipping Layers` row to the English **Parent Tab** section.
  - Added the entire **父级选项卡** section to the Chinese help — it was previously absent.
    The new section includes setup instructions and the same clipping-layer caveat.
  - Caveat text (all languages): clipping layers (✂) only follow the base layer's transform
    if both layers share the same parent in the Parent tab; if only the base has a parent,
    the clipping layer stays at its original canvas position and the mask alignment breaks.

---

## v2.21.0 — 2026-06-07

### Overview
Full clipping-mask support across the canvas preview and Capture output. Clipping layers
(layers with the Photoshop "clip to layer below" flag) are now detected, propagated to the
frontend, and rendered using an offscreen-canvas `source-atop` compositing technique.
R/MR rigs placed on a clipping layer work correctly while the clipping shape is enforced by
the base layer's alpha. Additionally, double-rendering of clipping layers in the server-side
manual compositor is fixed.

### Added
- **`clipping` field on layer-tree nodes** — `server.py::_build_layer_tree` and
  `psd_utils.py::_build_layer_node` now emit `"clipping": true|false` for every layer node.
  This was the root cause of clipping not working: the frontend received nodes without the
  flag, so all layers appeared as non-clipping.

- **`renderChildren(children, skipCgMembers)`** — new function inside `renderLayersToCtx`
  that replaces direct `for...of n.children` iteration. It scans the child array and groups
  consecutive clipping layers with their base layer into a "clipping stack", delegating to
  `renderClippingStack` when clips are found.

- **`renderClippingStack(base, clipLayers, skipCgMembers)`** — offscreen-canvas compositor:
  1. Creates a temporary canvas the same size as the main canvas.
  2. Copies the current camera transform to the offscreen context via `ctx.getTransform()` /
     `tmpCtx.setTransform()`.
  3. Temporarily swaps the closed-over `ctx` variable to `tmpCtx`; all drawing functions
     (`drawLeaf`, `applyRigTransform`) automatically target the offscreen canvas.
  4. Draws the base layer, then draws each clipping layer with
     `globalCompositeOperation = 'source-atop'` (clips to base's opaque pixels).
  5. Resets the transform and composites the offscreen canvas onto the main canvas 1:1.
  - R/MR rigs on clipping layers are fully applied inside `drawLeaf` before the
    `source-atop` clip is enforced, so both transform and clipping work simultaneously.

- **`✂` badge in layer panel** — `_mkLayerEl` appends a small `✂` span when `node.clipping`
  is true, giving visual feedback in the Layers tab and the SW `+L` dropdown.

- **i18n key `clippingLayerBadge`** added to ja / en / zh for the badge tooltip.

### Fixed
- **`get_layer_image_by_id` (canvas layer fetch)** — switched from `layer.composite()` to
  `layer.topil()` for non-group layers. `composite()` embeds associated clipping layers into
  the base layer's image, causing the clipping layer to appear twice on the canvas and making
  R/MR rigs on those layers invisible. `topil()` returns raw pixel data only; clipping is
  handled entirely by `renderClippingStack` at draw time.

- **`_manual_composite` / `_manual_composite_ordered`** — clipping layers are now skipped
  (`if getattr(layer, "clipping", False): return`). The base layer's `layer.composite()`
  already includes its clipping layers, so iterating and drawing them separately caused
  double rendering in the server-side compositor (both routes: `layer_order` and fallback).

### Changed
- **`renderLayersToCtx` signature** — parameter renamed from `ctx` to `ctxArg`; internal
  `let ctx = ctxArg` allows the variable to be temporarily reassigned to the offscreen
  context inside `renderClippingStack` without touching any call sites.
- **`renderOneNode` group path** — the two inline `for (const child of n.children)` loops
  are replaced by `renderChildren(n.children, skipCgMembers)`.

---

## v2.20.0 — 2026-06-07

### Overview
The single `+` button in the Switch tab is replaced by three distinct add buttons —
`+L` (Layer), `+P` (Piece), `+C` (Composite) — each producing a different slot entry
type. A new `mode: 'composite'` field on group/folder entries makes the entire group count
as a single slot whose member layers are composited together, contrasting with
`mode: 'piece'` (the existing per-layer expansion behavior). Each entry row now shows a
color-coded type badge and the dropdown is filtered to show only relevant options for
that entry type.

### Added
- **`+L` / `+P` / `+C` buttons** — replace the single `+` button in the Switch tab bar:
  - **`+L` (Layer)** — adds an individual PSD layer as a string entry (1 slot); dropdown
    shows leaf layers only
  - **`+P` (Piece)** — adds a custom group or PSD folder group with `mode: 'piece'`
    (default expansion behavior: 1 slot per member/leaf layer); dropdown shows groups and
    folders only
  - **`+C` (Composite)** — adds a custom group or PSD folder group with
    `mode: 'composite'` (entire group = 1 slot; all member layers rendered together);
    dropdown shows groups and folders only
  - `makeAddSwBtn(text, tipKey, mode)` helper in `_buildDOM` creates all three buttons
  - i18n keys added: `addLayerEntryTooltip`, `addPieceEntryTooltip`,
    `addCompositeEntryTooltip`, `noAssignableGroup` (ja/en/zh)

- **`mode: 'composite'` entry field** — new optional field on `psd_group` / `custom_group`
  entries in `pt.groups`:
  - Backward-compatible: entries without `mode` (all v2.19 data) continue to behave as
    `'piece'`
  - `expandSwGroupEntries` — composite branch returns a single slot
    `{ id, entryIdx, mode:'composite', memberIds:[...] }` instead of per-leaf entries
  - `countSwSlots` — composite entries always contribute 1, regardless of member count
  - `renderLayersToCtx` SW loop — composite slot activates/deactivates all `memberIds`
    together via a loop over `slot.memberIds`; piece slot still controls a single `id`

- **Type badges in Switch tab entry rows** (`[L]` / `[P]` / `[C]`):
  - Rendered as a small colored `<span>` to the left of the step-angle label
  - L → blue (`#89b4fa` on `#2a2a4a`), P → cyan (`#89dceb` on `#152535`),
    C → orange (`#fab387` on `#3a2515`)

### Changed
- **`_addSwGroup(mode)`** — gained `mode` parameter (`'layer'` | `'piece'` | `'composite'`):
  - `'layer'`: pushes the first leaf layer ID (string) found in `layerTree`
  - `'piece'` / `'composite'`: pushes `{ type:'custom_group'|'psd_group', id, mode }`
    preferring the first custom group, falling back to the first PSD folder group
- **`_renderSwitchTab` entry loop**:
  - `slotCount` set to `1` for composite entries (was `leaves.length`)
  - Orphan detection for composite: checks `leaves.length === 0` (group/folder empty
    or deleted) rather than `slotCount === 0`
  - Angle range label: range notation (`0°–60°`) suppressed for composite (always
    single angle)
  - Dropdown options filtered by entry type: string entries show layers only; object
    entries show custom groups + PSD folder groups only
  - Change handler preserves `entry.mode` when updating the selected group/folder:
    `pt.groups[i] = { type, id, mode: entry?.mode ?? 'piece' }`

### Schema addition
```jsonc
// pt.groups entry (new mode field)
{ "type": "custom_group", "id": "...", "mode": "piece" }      // +P: per-layer slots
{ "type": "psd_group",    "id": "...", "mode": "composite" }  // +C: 1 composite slot
```
Entries without `mode` default to `'piece'` (backward compatible with v2.19 data).

---

## v2.19.0 — 2026-06-06

### Overview
Four improvements: (1) thumbnails for model/pose/pose+SW saves are now always captured with
rig labels and the output-size label hidden, then the UI state is restored; (2) the Switch tab
now accepts PSD folder groups as expandable per-layer slot entries; (3) custom groups in the
Switch tab also expand per-layer (matching PSD folder behavior); (4) modal pose-save thumbnails
no longer show a dark outer frame caused by camera zoom state.

### Fixed
- **Dark outer frame in modal pose-save thumbnails** — `_savePoseFromModal()` /
  `_savePoseWithSwFromModal()` computed `_computeModalOutputFrame()` under the current camera
  state; when the user had zoomed in, the output frame extended beyond the preview canvas
  bounds and `drawImage` captured dark canvas background around the content:
  - Before capture: `savedCam = { ...this._previewCam }`, then reset to
    `{ ...this._defaultPreviewCam }` so the output frame is always within canvas bounds
  - After capture: restore `this._previewCam = savedCam` and call `_drawPreview()` to return
    to the user's camera state
- **Rig labels and output-size label visible in saved thumbnails** — model, pose, and
  pose+SW saves captured thumbnails while `node._showRigLabels` and the `512 × 512` frame
  label were still active; replaced `createNodeCanvasNoLabel` (offscreen canvas — incorrectly
  produced small/dark results) with `captureThumbFromNode`:
  - Save `node._showRigLabels`; set to `false`
  - Call `drawNodeCanvas(node, { skipFrameLabel: true })` — suppresses both rig labels and
    the output-size text
  - Crop and export; restore `node._showRigLabels`; call `drawNodeCanvas(node)` to redraw
  - Modal saves (`_savePoseFromModal`, `_savePoseWithSwFromModal`) apply the same pattern
    using `this._showRigLabels` + `this._drawPreview()`

### Added
- **PSD folder groups as Switch entries** (`[フォルダ]` / `[Folder]` / `[文件夹]`):
  - `getPsdGroupLeaves(groupId, layerTree)` — recursively collects all non-group descendant
    IDs from a PSD folder node
  - `expandSwGroupEntries(groups, layerTree, customGroups)` — flattens `pt.groups` entries
    into a per-slot list; `string` → 1 slot, `{type:'psd_group'}` → N leaf slots,
    `{type:'custom_group'}` → N `layer_ids` slots
  - `countSwSlots(groups, layerTree, customGroups)` — sums total slot count across all
    entries (dissolved entries contribute 0)
  - Switch tab dropdown includes `[フォルダ] <name>` options for every PSD group node in the
    layer tree (recursive); stored as `{ type: 'psd_group', id }` in `pt.groups`
  - Angle display: 1 slot → `"30°"`, multiple slots → `"0°–60°"` range notation
  - Orphaned entry (PSD folder dissolved): red row background, ⚠ tooltip icon, angle shown
    as `"-"`; entry must be deleted manually
  - Max-slot guard (`> 12`) applies across all entry types combined
  - i18n keys added: `psdGroupPrefix` (ja/en/zh), `swGroupOrphaned` (ja/en/zh)

- **Custom groups as Switch entries** (`[グループ]` / `[Group]` / `[组]`) — expand per-layer:
  - Previously custom groups were stored as plain string IDs in `pt.groups` and treated as
    single slots with no actual rendering effect
  - Now stored as `{ type: 'custom_group', id }`; `expandSwGroupEntries` expands each
    custom group into per-`layer_ids` slots, identical to PSD folder expansion
  - Dropdown option values changed from `cg2.id` to `cg:<id>` to distinguish from layer IDs;
    change handler recognizes `cg:` prefix and writes `{ type: 'custom_group', id }` to
    `pt.groups[i]`
  - `_addSwGroup()` default new entry for custom groups is now `{ type:'custom_group', id }`
    instead of a bare string
  - Orphaned handling: if the custom group no longer exists in `this.state.customGroups`,
    `slotCount = 0` → shown as orphaned with ⚠ (same as PSD folder)
  - `renderLayersToCtx` and `drawRigOverlay` both pass `cgList` / `customGroups` to
    `expandSwGroupEntries` so SW visibility switching works for all entry types

### Changed
- **`drawNodeCanvas` signature** — added `{ skipFrameLabel = false, targetCanvas = null }`
  options object; output-size label block is wrapped in `if (!skipFrameLabel)` guard
- **`captureThumbFromNode(node, thumbW, thumbH)`** — replaces the removed
  `createNodeCanvasNoLabel`; uses the "temporarily disable → draw → capture → restore"
  pattern on `node._nodeCanvas`; used by all 5 thumbnail capture paths:
  model save (140×140), modal pose save fallback (140×auto), modal pose+SW save fallback,
  quick pose save (node contextmenu), quick pose+SW save (node contextmenu)

### Updated
- **Help dialog** (`_showHelp`) — all three languages (ja/en/zh) updated:
  - Switch tab section fully rewritten: entry types ([Group]/[Folder]/[Layer]), slot
    expansion behavior, angle range notation, 12-slot max, orphaned ⚠ warning
  - Pose mode: note added that thumbnails are captured with labels hidden automatically
  - Layer tab: custom group creation description mentions SW tab per-layer expansion
  - Camera (modal preview): RC reset button row added
  - Chinese (zh): Switch tab and Pose mode sections added (were previously absent)

---

## v2.18.0 — 2026-06-05

### Overview
Two improvements: (1) fixed a broken JS module import that prevented `psd_pose_editor.js` from
loading; (2) added a "?" help button to the PSD Model Editor footer that opens a scrollable
in-app help dialog in the user's language (ja/en/zh). Also added screenshots to all three
README files.

### Fixed
- **`psd_pose_editor.js` fails to load on ComfyUI startup** (`vite:preloadError`):
  - Line 1 used a relative import `../../scripts/app.js` which resolves to
    `/extensions/scripts/app.js` (non-existent) instead of `/scripts/app.js`
  - Changed to absolute path `/scripts/app.js`, matching `psd_loader.js` convention
  - The error appeared twice in the console because ComfyUI's Vite layer reported the
    same failed fetch from two code paths (`console-listener.js` direct + `App.vue:73`)

### Added
- **In-app help dialog** — "?" button added to the bottom-left of the PSD Model Editor footer:
  - Uses `margin-right: auto` on the button to left-align it while keeping all other footer
    buttons (`Cancel` / `Save` / `Pose` / `Apply`) right-aligned
  - `_showHelp()` method on `PSDModal`: builds a scrollable overlay dialog with sections
    covering Basic Operations, Layer Tab, Parent Tab, Switch Tab, Setup Mode, Pose Mode,
    and Camera controls (modal vs. node preview distinguished separately)
  - Content fully translated: Japanese / English / Simplified Chinese, selected via `getLang()`
  - Dialog closes on outside click or the "Close" button; rendered at `z-index: 10001`
    (above the main modal at 10000)
  - `getLang` added to the `i18n.js` import in `psd_loader.js`
- **Help dialog CSS** (`.psd-help-dialog`, `.psd-help-header`, `.psd-help-body`,
  `.psd-help-section`, `.psd-help-section-title`, `.psd-help-table`, `.psd-help-term`,
  `.psd-help-desc`) — dark-themed: blue section titles (`#89b4fa`), purple term
  cells (`#cba6f7`), muted description text (`#bac2de`)
- **i18n keys** `helpBtn`, `helpTitle`, `helpClose` added to ja / en / zh locales
- **README screenshots** — `## Screenshots` section inserted between Features and Installation
  in `README.md`, `README.ja.md`, `README.zh.md`; includes all 7 images from `docs/`
  (`1_node.png` – `7_capture.png`, excluding `thumb.png`) with language-appropriate captions

### Fixed (help content accuracy)
- Camera operation descriptions corrected after code review:
  - Roll is **not** available in the modal preview (`_previewCam` has no `roll` property;
    right-drag in the modal pans, not rolls)
  - Roll is **only** available on the node preview canvas: `Alt + right-drag`
    (`setupPreviewInteraction` → `e.altKey && e.button === 2`)
  - Camera reset button on the node is **RC** (not ↺ as initially written)
  - Help now shows two separate camera sections: "Modal Preview" (zoom + pan only) and
    "Node Preview" (zoom + pan + roll + RC reset)

---

## v2.17.0 — 2026-06-05

### Overview
Two maintenance updates: (1) plugin renamed to "PSD Figure Creator"; (2) i18n support added for
Japanese, English, and Simplified Chinese.

### Changed
- **プラグイン名変更** — "PSD Loader" → "PSD Figure Creator":
  - `psd_loader_node.py`: クラス名 `PSDLoaderNode` → `PSDFigureCreatorNode`、
    `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS` のキー・値を更新
  - `web/js/psd_loader.js`: `NODE_TYPE = "PSDFigureCreator"`、
    extension 登録名 `"psd_loader.PSDFigureCreator"` に更新
  - `psd_utils.py`: ログラベル `[psd_loader]` → `[psd_figure_creator]`
  - **注意**: 既存ワークフローの JSON に `"PSDLoader"` が保存されている場合は
    `"PSDFigureCreator"` に書き換えが必要

---

## v2.16.0 — 2026-06-05

### Overview
Security hardening: path traversal prevention across all file-handling endpoints, and
i18n (internationalization) support for Japanese / English / Simplified Chinese.

### Security
- **パストラバーサル修正** (`server.py`):
  - `/psd_loader/upload`: `field.filename` を `Path(...).name` でサニタイズ後、
    `save_path.resolve().is_relative_to(psd_dir.resolve())` で境界チェックを追加
  - `/psd_loader/layers`, `/psd_loader/layer_image`, `/psd_loader/preview`:
    クエリパラメータ `filename` を `Path(...).name` でディレクトリ成分除去
  - `/psd_loader/preview`: `width` パラメータを `min(..., 4096)` で上限制限
  - エラーメッセージからファイルパスを除去（内部情報漏洩対策）
- **パストラバーサル修正** (`psd_loader_node.py`):
  - `psd_dir / psd_filename` → `psd_dir / Path(psd_filename).name`
- library 系エンドポイント（`/psd_loader/library/...`）は既存の `".."` チェックで対応済み

### Added
- **i18n 対応** — `web/js/i18n.js` を新規作成:
  - 対応言語: 日本語 (`ja`)・英語 (`en`)・簡体字中国語 (`zh`)
  - `navigator.language` で起動時に自動検出（`zh*` → zh、`ja` → ja、それ以外 → en）
  - `t(key, ...args)` 関数: `{0}` プレースホルダーで変数埋め込みに対応
  - `setLang(lang)` / `getLang()` でプログラムからの言語切り替えが可能
  - 翻訳キー数: 約 65 キー（ボタン・ツールチップ・アラート・confirm・prompt・キャンバステキスト）
- **`psd_loader.js` の全日本語文字列を `t()` に置換**:
  - `alert()` / `confirm()` / `prompt()` のメッセージ
  - `.textContent` / `.title` / `.placeholder` の UI テキスト
  - キャンバスオーバーレイテキスト（外部背景接続中メッセージ）
  - プレフィックス文字列（`[カスタム]` / `[SW]` / `[グループ]` / `[レイヤー]`）

---

## v2.15.0 — 2026-06-04

### Overview
Three UI improvements: (1) a New button in the setup modal file bar to start fresh without any
rigging; (2) tab hover/active style unified across all three tabs; (3) pose save button right-click
now saves switch state (SW angles) together with the pose instead of applying the last saved pose.

### Added
- **「✨ 新規」ボタン** — セットアップモーダルのファイルバーに追加（PSDボタン左横）:
  - クリックで確認ダイアログ → `layer_config` ウィジェットを `"{}"` にリセット
  - リギング・ポーズ・SWレイヤー・SWポイントをすべてクリア
  - `_rigMode` を `'normal'` に戻し、`_reloadFromNode()` でUI再描画
  - PSDボタンと同じ `flex:1` を付与し両ボタンが均等幅になることで PSD ボタン幅を実質半減
- **`_savePoseWithSwFromModal()`** — モーダルの「📷 ポーズ」ボタン右クリック用の新メソッド:
  - `sw_angles: {pointId: angle}` をポーズファイルに追加して保存
  - SWポイントの角度のみ記録（x/y/radius などセットアップ座標は含まない）

### Fixed
- **ペアレントタブの白線** — `mkTabBtn` のインライン CSS を `border-left/right/top:none` から
  `border:none` に変更。ホバー時に `.psd-btn:hover` の `border-color` が `#6c7086` に変化し
  bottom border が白線として見えていた問題を解消
- **タブホバー挙動の不統一** — 上記修正により 3 タブすべてで `background` 変化のみが起きるよう統一

### Changed
- **タブ選択の赤枠表示** — `updateTabStyle()` を更新し、アクティブタブに
  `outline: 2px solid #f38ba8` を追加（`outline-offset:-2px` でボタン内側に収める）。
  非アクティブタブは `outline: none`
- **ポーズ保存ボタン右クリックの動作変更** (ノード・モーダル共通):
  - 変更前: 直前に保存した `node._poseSnapshots[0]` を `layer_config` に適用
  - 変更後: 現在のスイッチ状態（SW角度）込みでポーズを名前付き保存
  - 保存成功時フラッシュ色: 左クリック = 緑 (`#44ff88`)、右クリック = オレンジ (`#ff8844`) で区別可能
  - モーダルの「📷 ポーズ」ボタンに `contextmenu` ハンドラを追加して同様の右クリック保存に対応
- **`_loadPose()` でスイッチ状態を復元** — ポーズファイルに `sw_angles` が含まれる場合、
  現在の `config.sw_layers` 内の各 SW ポイントの `angle` のみを上書き。
  x/y/radius などのセットアップ情報は一切変更しない
- **`poseSnapBtn.title`** — `"ポーズを保存（右クリックで適用）"` →
  `"ポーズを保存（右クリック: スイッチ状態込みで保存）"` に更新

### Schema addition
```jsonc
// pose ファイル（右クリック保存時のみ追加）
{
  "sw_angles": {
    "pointId": number   // SW ポイントの現在角度（radians）。pointId = swl.points[i].id
  }
}
```
`sw_angles` がないポーズファイルは従来通り `visibility` / `pose` のみ適用（後方互換）。

---

## v2.14.0 — 2026-06-04

### Overview
SWレイヤーUIのバグ修正と、レイヤー並べ替えが描画に反映されない根本的な問題を修正。

### Fixed
- **SWレイヤー行の▽トグル削除** — SWレイヤーは展開不要なためツリートグルを除去。行がフラット表示に統一
- **SWレイヤー行のクリック選択改善** — 以前は🔀アイコン部分しか選択できなかった問題を修正。
  行全体（名前テキスト含む）をクリックで選択可能に。名前はダブルクリックでリネーム（250ms タイマーで区別）
- **SW選択と通常レイヤー選択の排他制御** — SWレイヤーを選択した状態で通常レイヤーをクリックすると
  両方が選択状態になっていた問題を修正。`_mkLayerEl` / `_mkCustomGroupEl` のクリック時に
  `_selectedSwLayerId` をクリアするよう変更
- **SWグループにPSDレイヤーを直接割り当て可能** — スイッチパネルの＋ボタンを押したとき
  「カスタムグループがありません」エラーになっていた問題を修正。カスタムグループだけでなく
  個別PSDレイヤーもSWグループに割り当て可能とし、セレクトに `[グループ] / [レイヤー]` で表示
- **選択済みSWポイントのドラッグ操作改善** — スイッチパネルでSWポイントを選択しても
  キャンバス上での移動操作ができなかった問題を修正。`_selectedSwPointInfo` がある場合に
  sw_origin の 28px/zoom 以内のクリックでドラッグ開始するよう拡張
- **レイヤー並べ替えが描画に反映されない問題を修正** — `renderLayersToCtx` が常に
  PSD元順序（psd-tools 返却順）で描画していたため、UIでの並べ替えが表示に反映されなかった。
  `config.cg_order` を使って描画順を制御するよう根本修正:
  - `nodeMap` を構築し ID でノードを参照
  - `cgMemberIds` でカスタムグループ所属レイヤーを追跡（二重描画防止）
  - `cgOrder` がある場合は `[...cgOrder].reverse()` 順（下層→上層）で描画
  - カスタムグループ内も `layer_ids` の逆順で描画
  - `cgOrder` 未設定時は PSD 元順序にフォールバック

---

## v2.13.0 — 2026-06-04

### Overview
SWポイントの管理方式を全面刷新。従来は「カスタムグループごとにSWポイントを1つ配置する」仕組みだったが、**SWレイヤー**という専用コンテナを導入し、1つのSWレイヤーに複数のSWポイントを自由に配置できるようにした。SWポイントの座標もレイヤー相対からPSD絶対座標へ移行。

### Changed (Breaking)
- **データ構造変更** — `config.sw` (`{layerId: {...}}`) を廃止し `config.sw_layers`
  (`[{id, name, points:[{id, name, x, y, radius, angle, groups:[cgId]}]}]`) に変更
  - SWポイントはPSD絶対座標（旧: 配置レイヤーからの相対座標）
  - `LayerState.sw` → `LayerState.swLayers`
  - `toConfig()` が `sw_layers` を出力、`fromConfig()` が読み込む
  - 旧形式 `config.sw` は `fromConfig` 時に自動変換（後方互換）

### Added
- **SWレイヤー作成・削除ボタン** — レイヤータブ下部のボタンバー（グループ解除ボタン右隣）に
  「SW追加」「SW削除」ボタンを追加
- **SWレイヤーのレイヤーリスト表示** — レイヤーリスト先頭に紫ボーダー付きの
  `[SW] <名前>` 行として表示。クリックで選択（ダブルクリックでリネーム）
- **複数SWポイントの配置** — SWレイヤーを選択 → SWボタン → キャンバスクリックでSWポイントを配置。
  配置のたびにSWボタンが自動解除され、再度押すことで次のポイントを追加できる
- **SWポイント選択のスイッチパネル対応** — スイッチパネルに「SWレイヤーヘッダー + 配下のSWポイント一覧」を表示。
  クリックでSWポイントを選択（ダブルクリックでリネーム）、選択中ポイントのgroupsリストを展開表示
- `_mkSwLayerEl()` — SWレイヤー行DOM生成メソッド
- `_createSwLayer()` / `_deleteSwLayer()` — SWレイヤーの追加・削除

### Changed
- **`drawRigOverlay()`** — シグネチャ `swData={}` → `swLayers=[], selectedSwPointInfo=null`。
  SWポイント描画ループを `swLayers[].points[]` に変更。選択判定を `selectedSwPointInfo` で行う
- **`hitTestRig()`** — シグネチャ `swData={}` → `swLayers=[]`。
  戻り値のSWポイントヒットが `{layerId, type}` → `{swLayerId, swPointId, type}` に変更
- **`renderLayersToCtx()`** — SWによるカスタムグループ表示切り替えを `config.sw_layers` に対応
- **`_setupRigInteraction()`** — setupモードでのSW配置フローを変更：
  SWレイヤー選択 + SWボタン + キャンバスクリック → `_placeSwPoint(wx, wy)` 呼び出し
- **`_placeSwPoint()`** — シグネチャ `(layerId, wx, wy, entry)` → `(wx, wy)`。
  `_selectedSwLayerId` のSWレイヤーへ絶対座標でポイントを追加後、SWボタンを解除
- **`_renderSwitchTab()`** — swLayers構造でSWレイヤー/SWポイントを階層表示
- **`_addSwGroup()` / `_removeSwGroup()`** — `_selectedSwPointInfo` を使ってgroupsを操作
- **ノードキャンバス (`drawNodeCanvas`)** — `config.sw` → `config.sw_layers` に対応。
  SWハンドルドラッグ時のpivot計算をlayerEntry依存から絶対座標に変更

---

## v2.12.0 — 2026-06-04

### Overview
Three additions: (1) background color picker and local image file input on the node canvas;
(2) optional `background_image` IMAGE input port for compositing an upstream node's image
as the background layer; (3) fix to SW point name inline-rename (double-click was broken
by the row click handler re-building the DOM before the second click registered).

### Fixed
- **SW point name rename broken** — `row.addEventListener("click")` called
  `_renderSwitchTab()` on every click, rebuilding the DOM before the `dblclick` event on
  `nameEl` could fire; fixed with a 250 ms timer pattern (same as the layer tree rename):
  - `nameEl` click: start a 250 ms timer → on expiry, toggle selection and re-render
  - `nameEl` dblclick: cancel the timer, keep `_selectedSwLayerId` set, open inline input
  - `row` click handler skips when `e.target === nameEl` (nameEl owns its own selection logic)

### Added
- **Background color picker** — `BG` label + `<input type="color">` + `✕` clear button
  added below the Point Size slider in the node canvas widget; selecting a color sets
  `node._bgColorEnabled = true` and `node._bgColor`; clears local background image if set;
  `✕` sets `_bgColorEnabled = false`; canvas redraws immediately
- **Background image (local file)** — `🖼 画像` button + hidden `<input type="file"
  accept="image/*">` + `✕` clear button; file is read with `FileReader.readAsDataURL()` and
  stored as an `Image` object in `node._bgImage`; button label updates to the filename (up
  to 12 chars); selecting a file clears `_bgColorEnabled`; `✕` sets `_bgImage = null`
- **Background image (ComfyUI node input)** — optional `("IMAGE",)` input port
  `background_image` added to `PSDLoaderNode.INPUT_TYPES`; when connected, the upstream
  image is composited as the bottommost layer (letterbox resize, aspect-ratio preserved) via
  the new `_composite_on_bg()` helper; applied in both the `image_data` (Capture) path and
  the server-side compositing path
- **External background indicator** — when `background_image` input has an active link,
  `onConnectionsChange` hook shows `🔗 外部接続中` label in the BG control row; canvas
  displays a dark-green tinted placeholder with text
  `"🔗 外部背景画像接続中 / Queue Prompt で反映されます"` instead of the checker pattern

### Changed
- **`drawNodeCanvas()` background priority** — checker pattern is now the last fallback;
  priority: local image (`_bgImage`) → local color (`_bgColorEnabled`) →
  external connection indicator → checker
- **`captureNode()` background** — same priority order applied to the temp canvas before
  camera-transformed PSD layers are drawn; local background is baked into the captured PNG
- **`psd_loader_node.py` — `_composite_on_bg()` helper** — module-level helper function
  encapsulates background compositing (tensor → PIL → letterbox resize → alpha_composite);
  called in both the `image_data` branch and the server-side branch; `background_image` is
  now applied even when `image_data` (Capture) is present, so the composited result always
  includes the upstream background
- **`IS_CHANGED`** — includes `str(background_image.shape)` in the hash key so the node
  re-executes when the upstream image dimensions or content changes
- **`PREVIEW_WIDGET_H`** — `PREVIEW_IMG_H + 62` (484 px) → `PREVIEW_IMG_H + 88` (510 px)
  to accommodate the new BG control row (+26 px); `UI_WIDGET_H` 544 → 570 px

---

## v2.11.0 — 2026-06-04

### Overview
Two improvements: (1) bug fix — rig points were invisible after loading a model from the
Library or from the Setup modal's `📂 model` button; (2) new SW (Switch) point type that
toggles the visibility of registered custom groups by rotating a handle, allowing multi-state
layer switching (e.g. facial expression sets) without manual eye-toggle clicks.

### Fixed
- **Rig points not shown after Library model load** — `_loadModel()` set
  `node._layerImages = null` then called `refreshNodePreview()`, which fell into the
  `_compositeImg` branch of `drawNodeCanvas()` (no `_layerImages` → no rig overlay);
  fixed by awaiting `loadLayerImages()` directly inside `_loadModel()` and calling
  `drawNodeCanvas()` after `_layerImages` is populated
- **Rig points not shown after Setup modal model load** — `_reloadFromNode()` called
  `_initPreview()` → `_drawPreview()` while `_rigMode` was still `'normal'` (rig overlay
  guard: `if (this._rigMode !== 'normal')`), so points were invisible until the user
  manually clicked Pose/Setup; fixed by checking `config.rigging` keys after state rebuild:
  if rigging exists and `_rigMode === 'normal'`, automatically switch to `'pose'` mode and
  call `_updateRigModeUI()` before the preview draw

### Added
- **SW (Switch) point type** — new rig point that controls group visibility via angle:
  - **Visual**: green origin dot connected to a cyan handle by a green line; handle displays
    the active group index; selection ring (yellow) on origin in setup mode
  - **Setup arc overlay** — when the layer is selected in setup mode, a dashed green arc
    shows the full angular range (`30° × n` groups), with tick marks at each 30° step
  - **Placement**: select the SW button in the setup bar, pick a layer, click canvas to
    place the origin; drag the cyan handle to set radius and initial angle
  - **Pose mode**: dragging the cyan handle changes `swInfo.angle`; no radius change in
    pose mode (radius is setup-only)
  - **Group switching logic** (`renderLayersToCtx`): for each SW point, computes
    `activeIdx = floor(normalizedAngle / 30°)` where `normalizedAngle = angle mod (30°×n)`;
    the active group is unhidden (even if `visible:false`), all other registered groups are
    hidden; SW override takes priority over `cg.visible` but not over unregistered groups
  - **Maximum 12 groups** per SW point (12 × 30° = 360°)

- **SW button in Setup bar** — green-tinted `SW` button added to the right of `MR`;
  sets `_setupPointType = 'sw'`; highlighted with a green outline when active

- **Switch tab** — third tab added to the right panel (レイヤー | ペアレント | **スイッチ**):
  - Lists all SW points by name; click to select; double-click to rename inline; ✕ to delete
  - Selected SW expands to show its registered groups as rows with `angle°` label and a
    dropdown selector (shows all custom groups)
  - `+` button appends a new group slot (dropdown defaults to first CG); `−` removes the
    selected slot; limit 12 slots per SW

- **`_nextSwName()`** — generates unique auto-incremented names (`sw1`, `sw2`, …)
- **`_placeSwPoint()`** — places or moves the SW origin for the selected layer
- **`_renderSwitchTab()`** — renders the switch tab list and group slot rows
- **`_addSwGroup()` / `_removeSwGroup()`** — add or remove a group slot from the selected SW

### Changed
- **`LayerState`** — added `sw = {}` property; included in `toConfig()` as `sw:` key and
  restored in `fromConfig()` from `config.sw`
- **`drawRigOverlay()`** — added `swData = {}` as the last parameter; draws SW points after
  all R/MR points; call sites in `drawNodeCanvas()` and `PSDModal._drawPreview()` updated to
  pass `config.sw || {}`; early-return guard expanded to also allow `swData` entries
- **`hitTestRig()`** — added `swData = {}` as the last parameter; tests cyan handle
  (`sw_handle`) in both modes, and origin (`sw_origin`) in setup mode only; returns
  `{ layerId, type: 'sw_handle' | 'sw_origin' }`; all call sites updated
- **`_setupRigInteraction()` (modal)**:
  - Setup mousedown: SW button active → `_placeSwPoint()` on canvas miss; hit on
    `sw_handle` or `sw_origin` → `setup_drag`; mousemove handles `sw_handle` (radius +
    angle) and `sw_origin` (translate origin)
  - Pose mousedown: `sw_handle` hit → `sw_pose_drag` drag info with pivot at SW origin
  - Pose mousemove: `sw_pose_drag` → `swInfo.angle = atan2(wy−pivotY, wx−pivotX)`
- **`setupPreviewInteraction()` (node canvas)**:
  - Mousedown: `sw_handle` hit → `isRigDrag = true`, `rigDragInfo` with SW pivot stored
  - Mousemove: `hit.type === 'sw_handle'` branch updates `swInfo.angle` then writes
    updated config to the widget and redraws; `config.rigging` access guarded with `|| {}`
  - Hit-test guard changed from `if (config.rigging)` to `if (config.rigging || config.sw)`

### Schema addition
```jsonc
{
  "sw": {
    "layerId": {
      "name":   "sw1",          // display name (auto-incremented)
      "x":      100,            // origin X in layer-local coords
      "y":      200,            // origin Y in layer-local coords
      "radius": 80,             // distance to cyan handle (setup-editable)
      "angle":  0,              // current angle in radians (pose-editable)
      "groups": ["cg_a", "cg_b"]  // registered CG IDs; index 0 = 0°, 1 = 30°, …
    }
  }
}
```
Field is optional; configs without `sw` behave identically to prior versions.

---

## v2.10.0 — 2026-06-03

### Overview
Pose thumbnail display and save accuracy improvements. The Library pose grid now renders
thumbnails at the correct aspect ratio and responds correctly to S/M/L size switching.
Setup modal pose save now captures from the modal's own live preview instead of the
(potentially stale) node canvas. A green dashed frame overlay is always visible in the
Setup modal preview to mark the output crop region.

### Fixed
- **Pose thumbnail grid layout** — added `align-items:center` to each pose card
  (`flex-direction:column`); without it, `thumbBox` stretched to fill the grid-cell width
  while height stayed at `px`, causing a non-square distorted frame. S/M/L switching now
  correctly resizes both the grid columns and each card's thumb container
- **Pose thumbnail aspect ratio on save** — changed fixed 70×44 canvas to
  `140 × round(140 * fh/fw)` so the saved thumbnail matches the `output_width / output_height`
  aspect ratio rather than a hard-coded 16:10 approximation (applies to both node pose-save
  button and Setup modal pose-save button)

### Added
- **Output-frame overlay in Setup modal preview** — a semi-transparent green dashed border
  (`rgba(0,220,80,0.65)`) drawn after `ctx.restore()` in `_drawPreview()` marks the output
  crop region at all times, consistent with the node canvas overlay
- **`_computeModalOutputFrame()` method** — calculates the output-frame rectangle in screen
  coordinates of `this._previewCanvas`, taking the current camera zoom/pan into account;
  shared by `_drawPreview()` overlay and `_savePoseFromModal()` capture

### Changed
- **Setup modal pose save captures from `this._previewCanvas`** — `_savePoseFromModal()`
  now uses `_computeModalOutputFrame()` to crop from the live modal preview instead of
  `node._nodeCanvas` (which reflects the last Queue Prompt output, not the current pose
  state); falls back to `node._nodeCanvas` when PSD metadata is not yet loaded

---

## v2.9.0 — 2026-06-03

### Overview
Library modal improvements: pose thumbnail aspect-ratio fix, S/M/L thumbnail size toggle,
selected-model thumbnail preview in the left panel, and model save now includes a 140×140
thumbnail. Setup modal title renamed. PSD/model file loading now refreshes the modal's
layer tree and state in-place. Setup can open without a PSD loaded.

### Fixed
- **Pose thumbnail aspect ratio** — replaced the fixed 70×44 `<canvas>` with an `<img>`
  element sized `max-width:${px}px; max-height:${px}px; width:auto; height:auto;` inside a
  square container, so the original output-frame aspect ratio is preserved at all thumbnail
  sizes
- **Setup modal opens without PSD** — removed the `alert("先にPSDファイルを選択してください")`
  guard in `openLayerModal()`; the call site now passes `layers || []` to `PSDModal` so an
  empty tree is valid

### Added
- **Pose thumbnail S/M/L toggle** — three-button group added to the right-panel toolbar
  (`S` = 76 px, `M` = 110 px, `L` = 160 px); selected size highlights; `_thumbPx()` helper
  drives both the card container size and `grid-template-columns` via `_updateGridCss()`
- **Selected-model thumbnail panel** — 106 px area at the bottom of the left panel;
  single-click on a model list item selects it (highlights row, shows thumbnail);
  double-click loads the model onto the node and closes the modal
- **Model save includes thumbnail** — `_saveConfig()` renders a 140×140 frame from the
  output region of the node canvas and stores it as `content.thumbnail` alongside
  `psd_filename` and `layer_config`
- **`library_list_models` returns thumbnail** — server response now includes
  `"thumbnail": data.get("thumbnail")` so the library can display model thumbnails without
  a separate fetch
- **Setup modal file bar** — `📂 psd` / `📂 model` / `⟳` bar always visible above the
  setup/pose sub-bars; opening a PSD or model file calls `_reloadFromNode()` to rebuild
  `layerTree`, `state`, and re-render the tree and preview in place without reopening the
  modal
- **`_reloadFromNode()` method** — rebuilds `this.layerTree`, `this.state`, clears
  selection state, then calls `_renderTree()` and `_initPreview()`

### Changed
- **Setup modal title** — `"PSD レイヤー設定"` → `"PSD モデルエディタ"`
- **Model list interaction** — single-click selects (shows thumbnail); double-click loads;
  right-click deletes with confirmation (previously single-click loaded immediately)

---

## v2.8.0 — 2026-06-03

### Overview
Library modal implementation and UI restructuring. Model/pose save now writes to
`user_data/models/` and `user_data/poses/` on the server instead of triggering browser
downloads. PSD file buttons moved from node row 1 into the Setup modal header area.
Node shrinks from 3 rows to 2 rows. Library modal supports browsing, loading, and deleting
saved models and poses.

### Added
- **Library API — server (`server.py`)** — six new aiohttp routes under `/psd_loader/library/`:
  - `GET /models` — list all `.psd-model.json` files in `user_data/models/`
  - `GET /models/{name}` — fetch a single model file
  - `POST /models` — save model content to `user_data/models/<name>.psd-model.json`
  - `DELETE /models/{name}` — delete a model file
  - `GET /poses`, `GET /poses/{name}`, `POST /poses`, `DELETE /poses/{name}` — same CRUD
    for `.pose.json` files in `user_data/poses/`
  - All routes validate filenames against path-traversal characters (`..`, `/`, `\`)
- **Library modal (`LibraryModal` class)** — opens via the lib button (row 1 of node):
  - Left panel: model search input + model list; click to load model onto node, right-click
    to delete with confirmation
  - Right panel: pose search input + thumbnail grid; click to apply pose to node, right-click
    to delete; thumbnails use `<img>` tags so original aspect ratio is preserved
  - Header `×` button and overlay click both close the modal
- **Setup modal — file bar** — always-visible bar inserted between the modal header and the
  setup/pose sub-bars:
  - `📂 psd` — opens file picker to upload/select a PSD (button label updates to filename)
  - `📂 model` — opens file picker to load a `.psd-model.json` file directly
  - `⟳` — refreshes preview
- **Setup modal — Pose button** — `📷 ポーズ` button added to the footer (between `💾 保存`
  and `適用`); prompts for a name and saves current `visibility` + `pose` + 70×44 thumbnail
  to `user_data/poses/` via `_savePoseFromModal()`

### Changed
- **Model save** (`_saveConfig()`) — no longer triggers a browser download; now prompts for
  a name and POSTs `{ psd_filename, layer_config }` to `/psd_loader/library/models`
- **Pose snapshot button** — left-click now prompts for a name and POSTs to
  `/psd_loader/library/poses`; thumbnail on the button icon does not update after save
  (initial human-silhouette icon is preserved); right-click still applies the last-saved
  pose from `node._poseSnapshots[0]`
- **Pose snapshot icon** — initial canvas draws a human-silhouette icon on a dark background
  instead of the previous `+` text
- **Library button icon** — canvas replaced with a 3×2 coloured-block grid on a dark background
- **Node row layout — 3 rows → 2 rows**:
  - Row 1 (psd / psd model / ⟳) removed; those buttons now live in the Setup modal file bar
  - Remaining rows: `[lib] [pose] [Setup] [🏷] [RP] [RC]` and `[📸 Capture]`
  - `UI_WIDGET_H` updated to `BTN_ROW_H × 2 + PREVIEW_WIDGET_H` = 544 px
- **Setup modal opens without PSD** — removed the `alert("先にPSDファイルを選択してください")`
  guard so the modal can open with an empty layer tree; PSD can then be loaded via the
  in-modal file bar

---

## v2.7.0 — 2026-06-03

### Overview
Four improvements: (1) camera roll now correctly applies to captured output; (2) rig point
size and label size are now adjustable with a slider on both the node canvas and the Editor
modal; (3) model files (`.psd-model.json`) can be saved from the Editor and loaded back onto
the node; (4) the node button layout is redesigned, and the pose snapshot button gains full
save / apply functionality.

### Fixed
- **Camera roll not reflected in capture output** — `captureNode()` applied
  `translate → scale → translate` but omitted `rotate(cam.roll)`, so captured images
  were always axis-aligned regardless of viewport roll; added `tmpCtx.rotate(cam.roll || 0)`
  between the two translate calls, matching the transform sequence in `drawNodeCanvas()`

### Added
- **Point Size slider — node canvas** — `buildPreviewWidget()` appends a slider row
  (`range 0.5–3.0, step 0.1, default 1.0`) below the status label; value stored as
  `node._rigPointSize`; triggers `drawNodeCanvas()` on `input`
- **Point Size slider — Editor modal** — `previewPanel` receives the same slider between
  `_previewStatusEl` and the RP button; value stored as `this._rigPointSize`; triggers
  `_drawPreview()` on `input`
- **`drawRigOverlay` point size scaling** — signature gains `pointSize = 1.0` (last
  parameter); three internal size variables computed at entry:
  - `PR = round(7 × pointSize)` — rig point dot radius
  - `SR = round(12 × pointSize)` — setup-mode selection ring radius
  - `PSR = round(11 × pointSize)` — pose-mode selection ring radius
  - All `_drawRigPoint`, `ctx.arc`, and flip-indicator font sizes use these variables;
    radius label font scales as `max(8, round(10 × pointSize))px`
- **`_drawRigLabel` label size scaling** — gains `pointSize = 1.0` parameter; font size
  `max(8, round(11 × pointSize))px`; background rect and vertical offset scale proportionally
- **`hitTestRig` point size scaling** — gains `pointSize = 1.0` parameter; hit radius
  scales as `14 / zoom × pointSize` so click targets match visual point size
- **All `drawRigOverlay` / `hitTestRig` call sites** updated to pass the relevant
  `node._rigPointSize` or `this._rigPointSize` value
- **Model file save — Editor modal** — `💾 保存` button added to the modal footer (between
  キャンセル and 適用); `_saveConfig()` method serializes
  `{ psd_filename, layer_config }` (including `layer_order`) to a
  `<basename>.psd-model.json` file and triggers a browser download
- **Model file load — node** — `📂 psd model` button added to row 1 (between psd and ⟳);
  opens a JSON file picker; on load, writes `layer_config` to the widget, updates
  `psd_filename`, fetches layer tree from server, resets camera, and refreshes preview
- **Pose snapshot button — full implementation** — replaces the placeholder gradient;
  initial state shows a `+` icon on a dark canvas:
  - **Left-click → save**: captures `visibility` and `pose` from `layer_config`; renders
    a 36 × 22 px thumbnail from the output frame region of the node canvas; stores as
    `node._poseSnapshots[0]`; updates the button canvas; flashes green outline (600 ms)
  - **Right-click → apply**: writes the saved `visibility` and `pose` back to
    `layer_config` and calls `drawNodeCanvas()`
  - Thumbnail image loaded via `Image` object into the button canvas to handle async
    PNG decode correctly (`_refreshPoseSnapThumb` helper)

### Changed
- **Node button layout redesigned**:
  - **Row 1**: `[📂 psd (flex:1)] [📂 psd model (flex:1)] [⟳ (28px)]`
  - **Row 2**: `[lib PH (40px)] [pose snap (40px)] [Setup (flex:1)] [🏷] [RP] [RC]`
  - **Row 3**: `[📸 Capture]`
  - `Editor` button renamed to `Setup`
  - Library button remains a gradient-thumbnail placeholder (disabled) for the upcoming
    library modal
- **`PREVIEW_WIDGET_H`** recalculated from actual DOM measurements:
  `PREVIEW_IMG_H + 62` = 484 px (wrap padding 10 + border 2 + status 18 + slider 26 +
  margin buffer 6); `UI_WIDGET_H` updated to 574 px

---

## v2.6.1 — 2026-06-02

### Fixed
- **Parent tab: CG structure must not affect parent-child (rig) relationships** — the layer
  tab shows display order / custom group structure; the parent tab shows only user-set
  `layerParent` relationships between PSD layers; these two must be completely independent:
  - Moving a layer into a CG auto-sets `layerParent[lid] = cgId` for rig transform
    propagation, which was causing layers to disappear from the parent tab (they had a
    parent, but the CG parent was not displayed) and corrupting existing rig hierarchies
  - **`_ptAllOrderedIds()`** — rewritten to walk the PSD layer tree directly, completely
    ignoring `cgOrder` and CG `layer_ids`; the parent tab display order is now based solely
    on the original PSD structure, not on layer tab grouping
  - **`_ptDeriveRoots()`** — filter changed to `!lp[id] || cgIds.has(lp[id])`: layers
    whose `layerParent` points to a CG are treated as roots (the CG-assigned parent is
    invisible to the parent tab)
  - **`_ptDeriveChildren(parentId)`** — returns `[]` immediately when `parentId` is a CG
    ID, so CG nodes can never function as rig parents in the parent tab hierarchy

---

## v2.6.0 — 2026-06-02

### Overview
Three UX improvements to the rig / Editor workflow: (1) layer flip via Alt / Ctrl click on rig
points; (2) right-drag panning in Editor setup mode; (3) collapsible hierarchy in the parent tab.

### Added
- **Layer flip in Pose mode** — Alt + click or Ctrl + click on any R or MR rig point
  (blue or red) toggles a per-layer flip transform:
  - **Alt + click** → toggle `pose[layerId].flipX` (horizontal mirror)
  - **Ctrl + click** → toggle `pose[layerId].flipY` (vertical mirror)
  - Both modifiers can be active simultaneously (`flipX && flipY` = 180° rotational symmetry)
  - Flip pivot is the R point (falls back to MR if no R); applied **after** rotation and
    **before** translation in `applyRigTransform` via `ctx.scale(±1, ±1)` around the pivot
  - Works in both the Editor modal (`_setupRigInteraction`) and the node canvas
    (`setupPreviewInteraction`); Alt+right-drag (camera roll) is unaffected because roll
    requires button 2
  - **`applyChainToPoint`** — flip added after rotation step:
    `if (p.flipX) x = 2*px - x; if (p.flipY) y = 2*py - y`
  - **`inverseChainToPoint`** — inverse flip inserted between translation undo and rotation
    undo (flip is self-inverse: same formula)
  - **`getAncestorChain` / `buildAncestorChain`** — chain-inclusion condition extended to
    `|| p.flipX || p.flipY` so flipped ancestors are included even when angle/tx/ty are zero
  - **`hasTf`** in `renderLayersToCtx` render loop — extended with `|| p.flipX || p.flipY`
    for both the group branch and the leaf branch
  - **Flip indicator in `drawRigOverlay`** — `↔` (flipX), `↕` (flipY), or `↔↕` (both)
    drawn in yellow (`rgba(255,220,0,0.95)`) below the pivot point, visible in all modes

### Fixed
- **Editor setup mode: panning blocked when layer selected** — any click that missed an
  existing rig point immediately called `_placeSetupPoint()`, making it impossible to pan
  the preview canvas while a layer was selected; fixed by checking `e.button === 2` at the
  top of the setup branch and entering `isPanning` state for right-button presses, leaving
  left-click for point placement as before

### Changed
- **`_renderParentTab` — collapsible hierarchy** — parent tab now supports collapse /
  expand using the existing `collapsedIds` set:
  - Nodes with at least one `layerParent` child show a `▶ / ▼` toggle button; clicking it
    hides or reveals the subtree without affecting other tabs
  - Custom group nodes (`cg_xxx`) that appear as parents in `layerParent` are now resolved
    via `this.state.customGroups` and displayed as `📂 [CG] name`; previously they were
    silently skipped because `_findNodeById` only searches the PSD layer tree
  - Clicking a CG row in the parent tab selects it (sets `_selectedCgId`), matching the
    behavior of the layer tab
  - Eye button and inline rename (PSD layers only via dblclick) preserved

### Schema addition
```jsonc
{
  "pose": {
    "layerId": {
      "flipX": boolean,  // optional; horizontal flip around R/MR pivot
      "flipY": boolean   // optional; vertical flip around R/MR pivot
    }
  }
}
```

---

## v2.4.0 — 2026-06-02

### Overview
Two improvements: (1) custom groups can now have rig points assigned directly, and those
points propagate transforms to member layers via `layer_parent`; (2) the Editor modal preview
now shows a PSD canvas boundary line matching the node canvas.
Includes fixes for orange-handle drag not working in Editor pose mode, and group rig not
moving member layers on the node canvas.

### Added
- **Custom group rigging** — custom groups can now be selected in Setup mode and have R / MR
  rig points placed on them; the group acts as a virtual layer with `left:0, top:0` and PSD
  canvas dimensions (`width:psdW, height:psdH`)
  - **`getEffectiveImageMap(node, config)` (global helper)** — returns `node._layerImages`
    merged with a virtual entry `{img:null, isCgLayer:true, left:0, top:0, width, height}`
    for each custom group that has no existing entry; used by all rendering and interaction
    paths on the node canvas
  - **`PSDModal._getEffectiveImageMap()`** — same logic scoped to the modal's `this.state`
  - **`drawRigOverlay` / `hitTestRig`** gain a `customGroups = []` parameter; any custom
    group whose ID appears in `rigging` is appended as a virtual node `{id, name}` to
    `allLayers` so its rig points are drawn and hittable
  - **`_getSelectedLayerId()`** updated to return `this._selectedCgId` first so a selected
    custom group is recognized as the Setup target
  - **`_deleteSelectedRig()`** updated to delete the rig of `_selectedCgId` when a custom
    group is selected
- **PSD canvas boundary in Editor modal** — a yellow dashed border (`rgba(255,255,100,0.5)`,
  `1/zoom` px wide) is drawn around `(0, 0, psdW, psdH)` inside the camera transform block
  in `_drawPreview()`, matching the node canvas boundary style

### Changed
- **`_createGroup()`** — after creating the group, automatically sets
  `this.state.layerParent[lid] = cgId` for every member layer that has no existing
  `layerParent` entry; also sets `this._selectedCgId = cgId` so the new group is immediately
  selected and ready for rig point placement
- **`_moveItemToGroup()`** — when a layer is dragged into a group, sets
  `layerParent[itemId] = groupId` if the item is not a CG and has no existing parent;
  when it is removed from its previous group, clears `layerParent[itemId]` if that group
  was its parent
- **`_removeItemFromGroup()`** — clears `layerParent[itemId]` when the removed item's
  recorded parent matches the group being left
- **`_ungroup()`** — now also deletes `rigging[targetId]`, `pose[targetId]`, and clears
  `layerParent` entries that pointed at the dissolved group
- **All rendering / interaction calls** updated to use effective image maps and pass
  `customGroups`:
  - `drawNodeCanvas()` — uses `getEffectiveImageMap`; passes `_config.custom_groups` to
    `drawRigOverlay`
  - `captureNode()` — uses `getEffectiveImageMap` (fixes group rig missing in output image)
  - `setupPreviewInteraction` mousedown / mousemove — uses `getEffectiveImageMap`; passes
    `config.custom_groups` to `hitTestRig`
  - `_setupRigInteraction` (modal) mousedown / mousemove — uses `_getEffectiveImageMap()`
    for entry lookup and `buildAncestorChain` call; passes `this.state.customGroups` to
    `hitTestRig`
  - `_drawPreview()` — uses `_getEffectiveImageMap()`; passes `this.state.customGroups` to
    `drawRigOverlay`

### Fixed
- **Editor pose mode: orange handle not draggable** — `pose_drag` in `_setupRigInteraction`
  used `const entry = node._layerImages[layerId]` directly; for custom-group rig IDs this
  returned `undefined`, causing a TypeError that silently prevented `p.tx/ty` from updating;
  fixed by using `this._getEffectiveImageMap()[layerId]`; same fix applied to the
  `buildAncestorChain` call inside the orange branch
- **Node canvas: group rig not moving member layers** — `_moveItemToGroup` did not update
  `layerParent`, so layers added to a group via drag-and-drop after group creation had no
  ancestor chain; `renderLayersToCtx → getAncestorChain` therefore returned an empty chain
  and the group's `tx/ty` was never propagated; fixed by auto-setting `layerParent` in
  `_moveItemToGroup` (same guard used in `_createGroup`: only if not already set)

---

## v2.3.0 — 2026-06-02

### Overview
Camera roll on the node canvas preview: Alt + right-drag rotates the viewport around the
canvas center. All existing camera-transformed overlays (PSD boundary, rig points) correctly
follow the roll.

### Added
- **Camera roll** — `node._camera.roll` (radians, default `0`) applied as
  `ctx.rotate(cam.roll)` between `ctx.translate(W/2, H/2)` and `ctx.scale(cam.zoom)` in
  `drawNodeCanvas()`, so the entire PSD + rig + boundary rotates around the canvas center
- **Alt + right-drag interaction** — `setupPreviewInteraction()` detects `e.altKey && e.button === 2`
  on `mousedown`; enters `isRolling` state; `mousemove` sets
  `cam.roll = rollStartRoll + dx * 0.005` (≈ 0.29°/px); drag cursor `ew-resize`; roll
  cleared on `mouseup` / `mouseleave` exit
- **`toWorld()` roll inverse** — canvas → PSD coordinate conversion in
  `setupPreviewInteraction` now applies `cos(-roll) / sin(-roll)` rotation to the
  canvas-center-relative pixel offset before dividing by zoom, so rig point hit-testing
  remains accurate at any roll angle
- **`setDefaultCamera()`** — initializes `roll: 0` in both `node._camera` and
  `node._defaultCamera`; camera reset (`RC` button) therefore also resets roll
- **PSD boundary overlay moved inside ctx transform block** — previously drawn after
  `ctx.restore()` using `worldToCanvas` (which ignored roll); now drawn as
  `ctx.strokeRect(0, 0, psdW, psdH)` inside the camera save/restore block with
  `lineWidth = 1/cam.zoom` and `setLineDash([4/cam.zoom, 4/cam.zoom])`, so the boundary
  rotates correctly with the viewport

---

## v2.2.0 — 2026-06-01

### Overview
Three groups of improvements: (1) rig points on the node canvas now correctly follow
`layerParent` ancestor transforms (matching the modal's existing behavior); (2) the node
button row gains 🏷 label-toggle and RP reset-pose buttons, and the Editor modal gets an
RP button below its preview; (3) the MR orange handle direction is now freely orientable
during setup instead of being fixed to the right — stored as a new `mr_angle` field.

### Fixed
- **Node canvas: R/MR points did not follow parent-layer transforms** — `drawRigOverlay`,
  `hitTestRig`, and the orange-handle drag handler were all called without `layer_parent`,
  so ancestor transforms were ignored on the node canvas:
  - `drawNodeCanvas()` now passes `_config.layer_parent || {}`, `_config.renamed || {}`,
    and `node._showRigLabels` to `drawRigOverlay`
  - `setupPreviewInteraction` mousedown now passes `config.layer_parent || {}` to
    `hitTestRig`; pivot position for `r` and `mr` types computed via
    `buildAncestorChain + applyChainToPoint` (same logic as the modal)
  - Orange-handle drag (`hit.type === 'orange'`) now applies `inverseChainToPoint` before
    computing `tx/ty`, so dragging respects the ancestor rotation axes; `chain` is stored
    in `rigDragInfo` at mousedown and reused in mousemove

### Added
- **`🏷` label toggle button on node row 2** — `node._showRigLabels` (default `false`);
  green outline when active; triggers `drawNodeCanvas(node)`; placed between Editor and RC
- **`RP` button on node row 2** — calls `resetNodePose(node)`, which sets every rigged
  layer's pose to `{angle:0, tx:0, ty:0}`, writes back to `layer_config`, and redraws;
  placed between 🏷 and RC so the row reads `[Editor] [🏷] [RP] [RC]`
- **`RP` button in Editor modal preview panel** — `modalRpBtn` appended below
  `_previewStatusEl`; resets `this.state.pose[id]` for every id in `this.state.rigging`
  and calls `_drawPreview()`; available in all rig modes (normal / setup / pose)
- **`resetNodePose(node)`** — new top-level helper function (added after `resetNodeCamera`)

### Changed
- **MR orange handle: freely orientable direction** — previously the orange handle was
  always displayed at `(mrOrigin.x + mr_radius, mrOrigin.y)` (fixed rightward) during
  setup; now it is positioned at angle `mr_angle` from the MR origin:
  - **`drawRigOverlay` setup branch** — `oX/oY` computed as
    `(sX + r·cos(mr_angle), sY + r·sin(mr_angle))` where `mr_angle` defaults to `0`;
    connecting dashed line and radius label follow the new `oY`
  - **`hitTestRig` setup branch** — orange hit target moved to the same angled position
  - **`_setupRigInteraction` setup_drag** — orange drag now updates both `mr_radius` (`hypot`)
    and `mr_angle` (`atan2`) from the drag delta, allowing the user to drag the handle in
    any direction
  - **`_placeSetupPoint()`** — when `mr_radius === 0` at first MR placement, initializes
    `mr_angle = 0` alongside `mr_radius = 50`

### Schema addition
```jsonc
{
  "rigging": {
    "layerId": {
      "mr_angle": number   // radians; 0 = rightward (default). New optional field.
    }
  }
}
```
Existing configs without `mr_angle` default to `0` (unchanged visual behavior for right-pointing handles).

---

## v2.1.0 — 2026-06-01

### Overview
UI refactor separating display order from parent-child relationships into two tabs, plus a
critical fix ensuring that `layerParent` rig-transform propagation no longer alters the
rendering order, and full visual/interaction support for rig points on child layers.

### Added
- **レイヤー / ペアレント タブ** — the right panel is now split into two tabs:
  - **レイヤータブ**: shows `cgOrder` display order with drag-and-drop, custom group
    create/ungroup buttons; `layerParent` indentation is not shown here
  - **ペアレントタブ**: shows `layerParent` parent-child hierarchy; buttons `▲ ▼ ◀ ▶`;
    order here is purely visual and has no effect on rendering
- **`parentTabOrder`** — new `LayerState` field (`parent_tab_order` in JSON) storing
  `{ roots, children }` for the parent tab's independent sibling order; `null` entries
  fall back to `cgOrder`-derived order; persisted via `toConfig`/`fromConfig`
- **`▲ ▼` buttons (parent tab)** — `_shiftParentTabItem(dir)` swaps a layer with its
  previous/next sibling in `parentTabOrder` without touching `cgOrder`
- **Tab-aware `_indent` / `_outdent`** — dispatches to `_indentParent` / `_outdentParent`
  (which update `parentTabOrder`) when the parent tab is active; falls back to the
  original `cgOrder`-based logic in the layer tab
- **Standalone rig-transform helpers** — `buildAncestorChain`, `applyChainToPoint`,
  `inverseChainToPoint` added as top-level functions for use by overlay and hit-test code

### Fixed
- **Rendering order preserved after `layerParent` assignment** — `renderLayersToCtx`
  no longer skips child layers in the main render pass; `drawLayerTree` (which reordered
  children after their parent) is removed and replaced by `getAncestorChain`, which
  accumulates parent rig transforms and applies them via `ctx.save/restore` to each child
  at its original `cgOrder` position — display order is fully determined by `cgOrder`, not
  by `layerParent`
- **Child rig points shown at correct visual position** — `drawRigOverlay` now accepts
  `layerParentMap` and applies each ancestor's `ctx` transform (rotation + translation)
  in a `save/restore` block before drawing the layer's rig points; points for child layers
  move correctly when a parent is posed
- **Child rig point hit detection corrected** — `hitTestRig` accepts `layerParentMap` and
  calls `applyChainToPoint` to convert each rig point from local to visual coordinates
  before distance comparison; clicking on a visually-moved rig point now registers correctly
- **Pose drag pivot uses visual coordinates** — when starting a pose drag on a child layer,
  `buildAncestorChain` + `applyChainToPoint` compute the pivot's visual position; angle
  delta is measured from the visual pivot, giving correct rotation behavior
- **MR orange-handle drag corrected for rotated ancestors** — `inverseChainToPoint` converts
  the drag position from visual (world) space back to the layer's ancestor-local space before
  computing `tx/ty`; motion direction now matches the ancestor's rotated axes

### Schema additions
```jsonc
{
  "parent_tab_order": { "roots": ["id", …] | null, "children": { "parentId": ["childId", …] } }
}
```
Field is optional; omitting it derives order from `cgOrder`.

---

## v2.0.0 — 2026-06-01

### Overview
Major structural additions: (1) PSD group layers can now carry R/MR rig points; (2) custom
groups can be nested arbitrarily; (3) a unified `cgOrder` list controls the display order of
custom groups and PSD layers together; (4) `◀ ▶` indent buttons enable parent-child
relationships between layers without creating a custom group; (5) `layerParent` propagates
parent rig transforms to child layers hierarchically (tail-chain use case).

### Added
- **Group layer rigging** — `loadLayerImages` now creates a pseudo-entry `{img:null, isGroup:true,
  left, top, width, height}` for every PSD group node; `hitTestRig`, `drawRigOverlay`, and
  `_placeSetupPoint` handle groups automatically; `renderLayersToCtx` applies the group's
  `rig/pose` transform to a `ctx.save/restore` block wrapping all its children
- **Nested custom groups** — `layer_ids` may now contain CG IDs (prefixed `cg_`); `renderCg()`
  is recursive; `_moveItemToGroup()` has a descendant-set cycle check before moving; parent
  visibility propagates recursively via `markHidden()`; `_mkCustomGroupEl` is draggable
  (`dragstart` / `drop`) so groups can be rearranged or nested by drag-and-drop
- **`cgOrder`** — new `LayerState` field (and `cg_order` in saved JSON) storing the top-level
  display sequence of root CG IDs and PSD root layer IDs (upper-to-lower order); `_renderTree`
  iterates `cgOrder` instead of separate CG-then-PSD passes, allowing groups and PSD layers to
  be freely interleaved; `_reorder()` updates `cgOrder` when both endpoints are at the root level;
  migration: configs without `cg_order` reconstruct the order as `[rootCgIds…, reversedPsdIds…]`
- **`◀ ▶` indent buttons** — added to the group bar (right of グループ解除); behaviour:
  - **▶ (indent)**: sets `layerParent[selId] = prevId` where `prevId` is the immediately
    preceding item in the same scope; if `prevId` is a CG the operation is a no-op (does not
    enter CGs); works inside custom groups without escaping them
  - **◀ (outdent)**: for layers — deletes `layerParent[selId]` (stays within its CG scope);
    for CGs — removes from parent CG and re-inserts into `cgOrder` / grandparent `layer_ids`
    at the parent's position + 1
- **`layerParent`** — new `LayerState` field (and `layer_parent` in saved JSON) mapping
  `childId → parentId` for layer-level parent-child relationships:
  - `_renderTree` computes a depth-first `displayOrder` per scope and indents children;
    only root items (no parent in same scope) are rendered at the top of each list;
    `collapsedIds` suppresses children
  - `renderLayersToCtx` builds a reverse map `layerChildrenMap`; `drawLayerTree(n, entry)`
    applies the layer's own `rig/pose` transform in a `ctx.save/restore` block, then recurses
    into children — child layers inherit the accumulated canvas transform from all ancestors;
    layers that have a `layerParent` entry are skipped in the main `render()` pass to prevent
    double-drawing
  - `applyRigTransform(entry, rig, p)` helper extracted to eliminate duplicated pivot /
    rotation / translation code across the group and layer branches

### Changed
- **`_createGroup()`** — if `_selectedCgId` is set, the new CG is appended to that group's
  `layer_ids` (sub-group); otherwise it is `unshift`-ed into `cgOrder` (root group)
- **`_ungroup()`** — removes the target CG from `cgOrder` and from all parent `layer_ids`;
  child CGs are promoted to `cgOrder` at the removed CG's former index position
- **`_moveItemToGroup()`** — removes the item from `cgOrder` when it transitions from root CG
  to nested CG; `_removeItemFromGroup()` re-inserts it into `cgOrder` when promoted back to root

### Schema additions
```jsonc
{
  "cg_order":    ["cg_xxx", "psd_layer_id", …],   // root display order (new)
  "layer_parent": { "child_id": "parent_id", … }  // layer hierarchy (new)
}
```
Both fields are optional; configs without them fall back to prior behaviour.

---

## v1.7.0 — 2026-05-30

### Overview
MR point system redesign. R and MR points are now strictly independent: placing R creates
only R (blue), placing MR creates only MR (red) — the previous auto-creation of both is
removed. MR now supports both rotation (drag red point) and translation (drag orange point)
in pose mode, with the orange handle and red dashed line visible in both setup and pose modes.
Visual style updated to match the particle renderer reference (red dashed line connecting
MR origin to orange radius handle).

### Changed
- **`_placeSetupPoint()`** — initialization refactored:
  - Previous: first placement always created `{ r:{…}, mr:{…}, mr_radius:0 }` regardless of
    which button was active
  - New: `if (!rig)` creates `{ mr_radius: 0 }` only; R button adds `rig.r` if absent; MR
    button adds `rig.mr` if absent — the two point types no longer coerce each other
  - Default `mr_radius = 50` is applied only when `mr_radius === 0` at MR placement time
- **`renderLayersToCtx()`** — rotation pivot logic generalized:
  - Previous: only `rig.r` was used as rotation pivot; MR-only layers could not rotate
  - New: pivot = `rig.r ?? rig.mr`; MR-only layers now rotate around `rig.mr`
- **`drawRigOverlay()` — pose mode branch** rewritten for MR:
  - MR origin (red dot) drawn at fixed world position `(entry.left + mr.x, entry.top + mr.y)`;
    no `tx/ty` applied, as MR is the rotation anchor
  - Orange dot drawn at `(MR_world + p.tx, MR_world + p.ty)` — tracks current translation
  - Red dashed line `[4,3]` / `rgba(220,50,50,0.85)` / 2px connects MR origin to orange dot
  - Orange range circle `[5,5]` / `rgba(255,136,0,0.4)` drawn around MR origin at `mr_radius`
  - All MR visuals (circle, line, orange dot) conditional on `mr_radius > 0`
- **`drawRigOverlay()` — setup mode branch** — connecting line color changed:
  - Previous: orange `rgba(255,136,0,0.7)`
  - New: red `rgba(220,50,50,0.85)` / `[4,3]` / 2px, matching pose mode
  - Radius label `R: {px}` added in orange next to the orange handle
- **`hitTestRig()` — pose mode branch** — MR and orange tested independently:
  - MR origin hit at fixed `(entry.left + mr.x, entry.top + mr.y)` (no tx/ty)
  - Orange hit at `(MR_world.x + tx, MR_world.y + ty)` — only when `mr_radius > 0`
  - Orange tested before MR so it takes priority when positions overlap (tx=ty=0)
- **Pose drag — modal (`_setupRigInteraction`) and node canvas (`setupPreviewInteraction`)**:
  - `hit.type === 'r'` → rotation around R (unchanged)
  - `hit.type === 'mr'` → rotation around fixed MR origin (`pivotX/Y = entry + mr.x/y`, no tx)
  - `hit.type === 'orange'` → translation: `p.tx = wx − mr.x`, `p.ty = wy − mr.y`, clamped to
    `mr_radius` circle (logic moved from former `'mr'` branch)
  - Both drag-start blocks (`mousedown`) compute `pivotX/Y` and `initAngle` for `'mr'` type

### Notes
- A layer can now have `r` only, `mr` only, or both; existing saved configs with both keys
  continue to work (R used for rotation if present, otherwise MR; MR orange for translation)
- Multiple points per layer (numbered) is deferred to a future version

---

## v1.6.0 — 2026-05-30

### Overview
Three improvements to the rigging/posing workflow: (1) the modal preview panel is enlarged
1.5× and gains the same pan/zoom camera as the node canvas; (2) rig points now display layer
name labels so nearby or overlapping points can be identified; (3) the rig point model is
corrected — R and MR are now fully independent systems, data keys renamed throughout.

### Added
- **Modal preview pan/zoom** — preview panel width `260 → 390 px`; modal width `720 → 850 px`;
  canvas internal resolution fixed at `366 × 520`; camera (`_previewCam: {x, y, zoom}`) set
  at open time to fit-zoom the PSD, same algorithm as the node canvas
  - Left-drag → pan (normal, setup-miss, and pose-miss all fall through to pan)
  - Mouse wheel → zoom around cursor (factor 1.12, range 0.05×–20×)
  - `_setDefaultPreviewCam()` helper recomputes fit-zoom from current PSD dimensions
- **Rig point labels** — `_drawRigLabel(ctx, x, y, label, isSelected)` helper renders a
  semi-transparent black background + white text (yellow when selected) above each rig point
  - `drawRigOverlay()` gains `showLabels = false` and `renamed = {}` parameters
  - Setup mode: always shown; label positioned above the R or MR point respectively
  - Pose mode: controlled by `_showRigLabels` flag (default `true`); a **🏷 ラベル** toggle
    button appears in the green pose bar (highlighted with green outline when active)
- **Pose mode bar** — `poseBar` element (green tint) shown below header when Pose mode is
  active; currently contains only the label toggle button; symmetric with `setupBar`

### Changed
- **Rig point model — R and MR are now independent**
  - `pivot` → `r` (Rotation): rotation-only point; posing rotates the layer around `r`
  - `stretch_origin` → `mr`, `stretch_radius` → `mr_radius` (Move and Rotation):
    translation-only point; `mr` is origin, orange handle sets `mr_radius`; posing drags the
    layer within the radius circle; `p.tx / p.ty` are updated
  - The two point types are designed for exclusive use per layer (one or the other); both can
    coexist but each operates independently
- **`renderLayersToCtx()`** — rewritten to handle R-only, MR-only, or both:
  - R present + `p.angle`: applies `translate(px,py) rotate(angle) translate(-px,-py)`
  - `p.tx || p.ty`: applies `translate(tx, ty)` (from MR interaction)
  - No rig or no non-zero pose values: draws as before
- **`drawRigOverlay()`** — rewritten per-point-type loop:
  - Guard changed from `if (!rig?.r)` to `if (!rig?.r && !rig?.mr)` so MR-only layers render
  - R block (blue dot) and MR block (red dot + orange radius handle) drawn independently
  - Selected-layer yellow ring follows the active point (R preferred over MR when both exist)
- **`hitTestRig()`** — same guard fix; setup and pose branches each test R and MR independently
- **`PSDModal._buildDOM()`** — rig button labels: `"🔵 Pivot"` → `"R"`, `"🔴 Stretch"` → `"MR"`;
  internal names `_btnPivot/_btnStretch` → `_btnR/_btnMR`; `_setupPointType` default `'pivot'` → `'r'`
- **`_drawPreview()`** — migrated from calling global `drawPreview()` (which reset canvas size
  to PSD dimensions) to inline camera-transformed rendering matching node canvas approach;
  rig overlay now rendered inside the `ctx.save/restore` camera block
- **`_setupRigInteraction()`** — completely rewritten; previously lacked pan/zoom; coordinate
  transform `toPsd()` now inverts camera matrix; `hitTestRig` receives `_previewCam.zoom`
- **Rig drag start (modal + node)** — `pivotX/Y` and `initAngle` computed only when
  `hit.type === 'r'` so MR-only layers no longer throw when `rig.r` is absent
- **`_placeSetupPoint()` and `setup_drag` init** — data object key `pivot:` → `r:`

### Schema change
```
rigging: {
  layerId: {
    r:         { x: number, y: number },   // was pivot
    mr:        { x: number, y: number },   // was stretch_origin
    mr_radius: number                       // was stretch_radius
  }
}
```
Existing saved workflows using the old keys will stop applying rig transforms (the keys will
simply be absent); re-place the rig points in Setup mode to migrate.

---

## v1.5.0 — 2026-05-30

### Overview
Layer rigging system. Two point types can be placed on each layer: a **pivot point** (blue)
that acts as the rotation centre, and a **stretch point** (red) that translates the layer
within a configurable radius. Setup is done in the Editor modal; posing works both in the
modal and directly on the node canvas (same interaction model as the 2D Pose Editor reference).

### Added
- **Rigging data in `layer_config`** — two new top-level keys:
  - `rigging`: `{ layerId: { pivot:{x,y}, stretch_origin:{x,y}, stretch_radius:number } }`
    — coordinates are in layer-local space (offset from `entry.left / entry.top`)
  - `pose`: `{ layerId: { angle:number, tx:number, ty:number } }`
    — `angle` = rotation around pivot (radians); `tx/ty` = translation from stretch interaction
- **`drawRigOverlay(ctx, layers, imageMap, rigging, pose, mode, selectedLayerId, setupPointType)`**
  — draws rig points on a canvas context; adapts to `'setup'` vs `'pose'` mode:
  - Setup: raw (un-posed) coordinates; shows orange handle + dashed radius circle + blue pivot + red stretch origin; highlights active point type with a ring
  - Pose: posed coordinates (pivot + tx/ty offset); blue pivot dot + red stretch dot
- **`hitTestRig(wx, wy, …)`** — returns `{ layerId, type:'pivot'|'stretch'|'orange' }` for the
  nearest rig point within a zoom-adjusted 14 px hit radius; used by both modal and node canvas
- **`_drawRigPoint(ctx, x, y, r, fill, stroke)`** — small helper for filled circle with stroke
- **Modal Setup mode** — toggled by [Setup] button in modal header:
  - Sub-bar appears with [🔵 Pivot] / [🔴 Stretch] type selector + [🗑 削除] delete button
  - Click on preview canvas → places selected point type at cursor position in layer-local coords
  - Drag existing point → repositions it
  - Drag orange handle → updates `stretch_radius`
- **Modal Pose mode** — toggled by [Pose] button:
  - Drag blue pivot dot → updates `pose[id].angle` via `atan2(mouse − pivot) − atan2(start − pivot)`
  - Drag red stretch dot → updates `pose[id].tx/ty`; clamped to `stretch_radius` circle
- **Node canvas rig interaction** — `setupPreviewInteraction()` now hit-tests rig points on
  `mousedown`; if a point is hit, enters rig-drag mode (same pivot/stretch logic as modal pose);
  if no point hit, falls through to existing pan behaviour; updates `layer_config` widget on
  every `mousemove` so `drawNodeCanvas()` shows live feedback
- **`node._rigSelectedLayerId`** — tracks which layer is highlighted (yellow ring) on the node
  canvas rig overlay

### Changed
- **`LayerState`** — added `rigging` and `pose` properties; both included in `toConfig()` and
  restored in `fromConfig()`
- **`renderLayersToCtx()`** — when a layer has both a `rigging` entry (with `pivot`) and a
  `pose` entry with non-zero values, applies `ctx.translate(tx, ty)` → `ctx.translate(pivotX, pivotY)`
  → `ctx.rotate(angle)` → `ctx.translate(-pivotX, -pivotY)` before `drawImage`; layers without
  rig data draw as before
- **`drawNodeCanvas()`** — calls `drawRigOverlay()` in pose mode after rendering layers;
  config object extracted to a named variable so it can be reused for the overlay call

### Fixed
- **Layer name rename double-click not firing** — `row.addEventListener("click")` called
  `_renderTree()` which rebuilt the DOM before `dblclick` could fire on the original `nameEl`;
  fixed by delaying the `_renderTree()` call 250 ms when the click target is `nameEl`; a
  `dblclick` arriving within that window cancels the timer via `clearTimeout`
- **Custom group name rename double-click not firing** — same root cause as above; same fix
  applied to `_mkCustomGroupEl`
- **Layer compositing order reversed** — psd-tools `enumerate(psd)` yields layers in
  back-to-front order (`psd[0]` = bottommost); `_renderTree` already used `.reverse()` for
  correct UI display (foreground at top), but `renderLayersToCtx` and `_manual_composite`
  also called `.reverse()` / `reversed()`, making the draw order front-to-back (each layer
  was painted *under* the previous one); removed all `reversed()` / `.reverse()` calls from
  the three compositing paths (`renderLayersToCtx`, `_manual_composite`,
  `_manual_composite_ordered`) so layers are drawn back-to-front as intended

---

## v1.4.0 — 2026-05-29

### Overview
Interactive preview canvas with pan/zoom/capture. The node preview is now a camera:
pan and zoom to frame the subject, then Capture to output exactly what is visible.
Output frame overlay shows the capture boundary based on output_width × output_height
aspect ratio. Capture triggers Queue Prompt automatically.

### Added
- **Interactive preview canvas** — replaced static `<img>` + placeholder with a `<canvas>`
  element (462 × 422 px internal); serves as the interactive camera viewport
- **Pan** — left-click drag moves the canvas view; direction and scale correctly account for
  CSS-to-canvas pixel ratio (`canvas.width / rect.width`) and zoom level
- **Zoom** — mouse wheel zooms around the cursor position (not canvas center); range 0.05×–20×
- **RC button** — resets camera to the fit-zoom state computed at PSD load time
  (`zoom = min(462/psdW, 422/psdH) * 0.95`); placed alongside Editor button in row 2
- **Capture button** — captures current viewport as `image_data` and immediately calls
  `app.queuePrompt(0, 1)` to run the node; button shows ⏳ Queuing… → ✅ Done! feedback
- **`image_data` widget** (backend) — added to `PSDLoaderNode.INPUT_TYPES` as optional STRING;
  when non-empty the backend decodes base64 PNG → PIL → tensor, bypassing server compositing;
  clears on workflow save via `app.graph.serialize` wrapper hook (same pattern as 2D Pose Editor)
- **`IS_CHANGED`** — added to `PSDLoaderNode`; hashes all parameters including `image_data`
  so the node re-executes whenever capture data changes
- **Output frame overlay** — semi-transparent dark mask outside the capture boundary, white
  border + L-corner markers + size label (`W × H`) at bottom-right; frame is the largest
  rectangle inside the preview canvas that matches `output_width / output_height` aspect ratio
- **PSD boundary overlay** — yellow dashed border showing PSD content extents within the
  viewport; rendered in world-space coordinates via camera transform inverse
- **`computeOutputFrame(node)`** helper — computes the crop rectangle `{fx, fy, fw, fh}`
  from output_width/height aspect ratio and preview canvas dimensions
- **`worldToCanvas(wx, wy, cam, W, H)`** helper — converts PSD world coordinates to canvas
  pixel coordinates under current camera state
- **Output widget callbacks** — `output_width` and `output_height` widget callbacks trigger
  `drawNodeCanvas(node)` immediately so the output frame redraws on value change

### Changed
- **Capture → viewport crop** — capture renders the output frame region (`fw × fh` in preview
  canvas space) mapped to `output_width × output_height`; transform:
  `scale(cam.zoom * outW/fw)` centered at frame center (`outW/2, outH/2`); mathematically
  equivalent to rendering the world region visible through the output frame rectangle
- **Node layout** — added third button row for Capture; `UI_WIDGET_H` updated:
  `BTN_H(30) × 3 + PREVIEW_WIDGET_H(450) = 540`
- **`_setNodePreview()`** — requests preview image at `canvas.width * 2` for higher
  resolution fallback when layer images are not yet cached
- **`PSDModal._apply()`** — calls `drawNodeCanvas(node)` instead of setting `img.src`
- **`refreshNodePreview()`** — calls `drawNodeCanvas(node)` directly when layer images cached

### Fixed
- **`ModuleNotFoundError: No module named psd_pose_editor`** — reverted `__init__.py` to
  original (only imports `psd_loader_node`); `psd_pose_editor` subpackage is a reference/test
  artifact and is not installed in the ComfyUI custom_nodes path

---

## v1.3.0 — 2026-05-28

### Overview
Resolved persistent node height / preview overflow issues caused by ComfyUI's DOM widget
placement system. Consolidated all custom UI elements into a single DOM widget to eliminate
multi-widget layout interference, and overrode `prototype.computeSize` to guarantee correct
node height regardless of ComfyUI's internal recalculation timing.

### Fixed
- **Preview overflows node frame (height too small)** — root cause: `computeSize()` called
  before DOM widgets are fully initialized returns incorrect height; ComfyUI also periodically
  re-calls `computeSize()` and resets `node.size[1]`, discarding manually set values
  - Fix 1 (rejected): `requestAnimationFrame` delay — ComfyUI overwrites size again after
    the callback fires
  - Fix 2 (final): override `nodeType.prototype.computeSize` to always return a minimum
    height of `UI_WIDGET_H + 80`, preventing ComfyUI from shrinking the node
- **`psd_btns` widget renders at full node height** — root cause: ComfyUI allocates a single
  DOM overlay container for all DOM widgets; multiple DOM widgets (`psd_btns`, `psd_preview`)
  caused placement interference where the first widget expanded to fill the entire container
  - Fix: merged `psd_btns`, `Editor` button, and `psd_preview` into one DOM widget (`psd_ui`)
    backed by a single `uiWrap` flex column container; ComfyUI now allocates exactly one
    overlay region with no cross-widget interference
- **4 px preview clip at bottom** — `PREVIEW_WIDGET_H` was 446 but actual `previewWrap`
  height is 450 (padding 10 + previewBox 422 + statusEl 18); corrected constant to match

### Changed
- `PREVIEW_WIDGET_H`: `PREVIEW_IMG_H + 24` (446) → `PREVIEW_IMG_H + 28` (450)
- `UI_WIDGET_H` new constant: `30 + 34 + PREVIEW_WIDGET_H` = 514
  - `30` = btnRow, `34` = editorBtn (height 26 + margin 8), `450` = previewWrap
- `addDOMWidget("psd_btns")` and `addWidget("button", "Editor")` removed; replaced by
  `editorBtn` HTML button and `btnRow` inside the unified `uiWrap` flex container
- `addDOMWidget("psd_preview")` replaced by `addDOMWidget("psd_ui")` (the unified container)
- `prototype.computeSize` override added in `beforeRegisterNodeDef` (before `onNodeCreated`)
  with `minH = UI_WIDGET_H + 80`; `onNodeCreated` and `onConfigure` now set `node.size`
  directly without `requestAnimationFrame`

---

## v1.2.0 — 2026-05-28

### Overview
Fixed preview area overflow, implemented fixed node size (474×733), and redesigned
preview widget with always-visible 422×422 area using inner-container isolation pattern.
Also fixed button stretching on wide nodes.

### Added
- **Fixed node size** (474×733) — `node.resizable = false` with `node.onResize` override
  enforces constant size; follows the same pattern as the 2D Pose Editor reference node
- **Always-visible preview area** (422×422) — preview placeholder (checker pattern) shown
  before PSD is loaded; replaced by the actual composite image after load
- **Checker placeholder canvas** — drawn programmatically as a 64×64 tiled checker,
  displayed full-size via CSS `width:100%; height:100%` with `image-rendering:pixelated`
- **`PREVIEW_IMG_H = 422`** and **`PREVIEW_NODE_W = 474`** module-level constants
  for centralized size management

### Fixed
- **Preview overflow / clipping to 29px** — root cause: `overflow:hidden` on the outer
  DOM widget element (whose height ComfyUI sets incorrectly) clipped the preview content
  - Fix: removed `overflow:hidden` from the outer `wrap`; added inner `previewBox` div
    with explicit `height:422px` and `overflow:hidden`; placeholder and img use
    `position:absolute; top:0; left:0; width:100%; height:100%` inside `previewBox`
  - ComfyUI cannot affect `previewBox` height since it is a child element, not the
    registered widget element
- **PSD load button stretching** — `psdBtn` with `flex:1` expanded to fill full node
  width when node was wide (e.g., output_width=1024); fixed by adding `max-width:220px`
- **Node size not updating** — previous `setTimeout + if (node.size[0] < PREVIEW_NODE_W)`
  conditional skipped height update when node was already wide; replaced with immediate
  unconditional `node.size[0] = PREVIEW_NODE_W; node.size[1] = node.computeSize()[1]`
- **Saved workflow restoring wrong node size** — `onConfigure` now also applies
  `node.size[0] = PREVIEW_NODE_W; node.size[1] = node.computeSize()[1]` to override
  stale saved sizes

### Changed
- Preview widget `computeSize(w)` now returns fixed `[w, PREVIEW_IMG_H + 24]` (446px)
  instead of dynamic `[w, node._previewH ?? 0]`
- Removed `_updateNodePreviewHeight()` function and all dynamic height calculation logic
- `buildPreviewWidget()` restructured: outer `wrap` (no overflow) → inner `previewBox`
  (fixed 422px, overflow:hidden) → placeholder + img (absolute positioned)
- Simplified `refreshNodePreview`, `_apply`, and canvas path to remove height update calls

---

## v1.1.0 — 2026-05-28

### Overview
Added layer order reflection in output image, node preview display, output size controls,
and Editor layer order display matching Affinity Photo (foreground at top).

### Added
- **Node preview widget** — composite preview rendered inside the node using server-side
  `/psd_loader/preview` API or client-side canvas (when layer images are cached)
- **`output_width` / `output_height` INT parameters** — resize output image; 0 = no resize;
  aspect ratio preserved if only one dimension is set
- **Layer order in output** — `layer_order` key saved to `layer_config` JSON in `_apply()`;
  `composite_with_config()` uses `_manual_composite_ordered()` when `layer_order` is present
- **`_manual_composite_ordered()`** in `psd_utils.py` — renders layers in the order specified
  by the frontend layer tree (foreground-first list, reversed for back-to-front compositing)
- **Frontend layer reordering** — drag-and-drop reorder in the Editor modal; reordered tree
  saved as `layer_order` in config on Apply
- **Foreground-first layer display** — Editor shows layers with foreground at top (reversed
  from psd-tools' back-first array) using `[...nodes].reverse()` in `_renderTree`
- **Canvas-based node preview** — when `node._layerImages` is cached, `drawPreview()` renders
  directly to a canvas and sets `img.src` as dataURL (no server round-trip)

### Fixed
- **Import path error** (`GET /extensions/scripts/app.js 404`) — changed from relative
  `../../scripts/app.js` to absolute `/scripts/app.js`
- **"Extension already registered" error** — deleted duplicate `web/psd_loader.js` (web root);
  active file is `web/js/psd_loader.js`
- **Files not reflected in ComfyUI** — created Windows Junction point linking development
  directory to ComfyUI custom_nodes directory

### Changed
- `psd_utils.py`: added `_manual_composite_ordered()` and modified `composite_with_config()`
  to use it when `layer_order` is present in config
- `psd_loader_node.py`: added `output_width`/`output_height` params and resize logic using
  `Image.LANCZOS`

---

## v1.0.0 — (prior session)

### Overview
Initial implementation of PSD Loader ComfyUI custom node.

### Added
- PSD file upload via `/psd_loader/upload` API endpoint
- Layer tree parsing and display in modal Editor
- Layer visibility toggle with eye button
- Custom group creation (drag-and-drop layers into named groups)
- Layer visibility reflected in composite output
- Node preview via `/psd_loader/preview` API
- Layer rename (double-click inline edit)
- `get_layer_image_by_id()` for per-layer image fetch
- `composite_with_config()` with three fallback methods (layer_filter, visible override, manual)
- Server routes: `/psd_loader/upload`, `/psd_loader/layers`, `/psd_loader/layer_image`,
  `/psd_loader/preview`
