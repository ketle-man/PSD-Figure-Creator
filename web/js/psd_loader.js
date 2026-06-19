import { app } from "/scripts/app.js";
import { t, getLang } from "./i18n.js";

const NODE_TYPE = "PSDFigureCreator";

// ================================================
// ワークフロー保存時に image_data を除外
// ================================================
setTimeout(() => {
    if (!app.graph) return;
    const _orig = app.graph.serialize.bind(app.graph);
    app.graph.serialize = function (...args) {
        const data = _orig(...args);
        if (data?.nodes) {
            for (const n of data.nodes) {
                if (n.type !== NODE_TYPE || !n.widgets_values) continue;
                // widgets_values 順: psd_filename(0), layer_config(1), output_width(2), output_height(3), image_data(4)
                if (n.widgets_values.length > 4) n.widgets_values[4] = "";
            }
        }
        return data;
    };
}, 500);

// ================================================
// CSS（一度だけ読み込む）
// ================================================
let _cssLoaded = false;
function ensureCSS() {
    if (_cssLoaded) return;
    _cssLoaded = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("../css/psd_loader.css", import.meta.url).href;
    document.head.appendChild(link);
}

// ================================================
// ウィジェット非表示
// ================================================
function hideWidget(node, name) {
    const w = node.widgets?.find(w => w.name === name);
    if (!w) return;
    if (w.element) {
        w.element.style.display = "none";
        w.element.style.height = "0";
        w.element.style.overflow = "hidden";
    }
    w.draw = () => {};
    w.computeSize = () => [0, -4];
}

function findWidget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

// ================================================
// ファイル選択 input（共有）
// ================================================
let _fileInput = null;
function getFileInput() {
    if (!_fileInput) {
        _fileInput = document.createElement("input");
        _fileInput.type = "file";
        _fileInput.accept = ".psd";
        _fileInput.style.display = "none";
        document.body.appendChild(_fileInput);
    }
    return _fileInput;
}

// ================================================
// 全レイヤー画像をロード（モーダルプレビュー用）
// ================================================
async function loadLayerImages(filename, layers) {
    const imageMap = {};

    async function fetchLayer(node) {
        if (node.kind !== "group") {
            const url = `/psd_loader/layer_image?filename=${encodeURIComponent(filename)}&id=${encodeURIComponent(node.id)}`;
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const blob = await res.blob();
                    const objUrl = URL.createObjectURL(blob);
                    const img = await new Promise(resolve => {
                        const i = new Image();
                        i.onload  = () => resolve(i);
                        i.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
                        i.src = objUrl;
                    });
                    if (img) {
                        imageMap[node.id] = {
                            img, objUrl,
                            left:   node.bbox.left,
                            top:    node.bbox.top,
                            width:  node.bbox.right  - node.bbox.left,
                            height: node.bbox.bottom - node.bbox.top,
                        };
                    }
                }
            } catch (_) {}
        } else if (node.bbox) {
            // グループ: 画像なしの擬似エントリ（リグポイント配置用にbbox情報だけ持つ）
            imageMap[node.id] = {
                img: null, objUrl: null, isGroup: true,
                left:   node.bbox.left,
                top:    node.bbox.top,
                width:  node.bbox.right  - node.bbox.left,
                height: node.bbox.bottom - node.bbox.top,
            };
        }
        if (node.children) {
            for (const child of node.children) await fetchLayer(child);
        }
    }

    for (const layer of layers) await fetchLayer(layer);
    return imageMap;
}

// ================================================
// SWグループ展開ヘルパー（PSDフォルダグループ対応）
// ================================================
function getPsdGroupLeaves(groupId, layerTree) {
    function find(nodes) {
        for (const n of nodes) {
            if (n.id === groupId && n.kind === 'group' && n.children) {
                const leaves = [];
                function collect(ns) {
                    for (const c of ns) {
                        if (c.kind !== 'group') leaves.push(c.id);
                        else if (c.children) collect(c.children);
                    }
                }
                collect(n.children);
                return leaves;
            }
            if (n.children) { const r = find(n.children); if (r) return r; }
        }
        return null;
    }
    return find(layerTree) || [];
}

function expandSwGroupEntries(groups, layerTree, customGroups = []) {
    const cgMap = {};
    for (const cg of customGroups) cgMap[cg.id] = cg;
    const result = [];
    for (let i = 0; i < groups.length; i++) {
        const entry = groups[i];
        if (typeof entry === 'string') {
            result.push({ id: entry, entryIdx: i });
        } else if (entry?.type === 'psd_group') {
            const leaves = getPsdGroupLeaves(entry.id, layerTree);
            if (entry.mode === 'composite') {
                result.push({ id: entry.id, entryIdx: i, mode: 'composite', memberIds: leaves });
            } else {
                for (const id of leaves) result.push({ id, entryIdx: i });
            }
        } else if (entry?.type === 'custom_group') {
            const cg = cgMap[entry.id];
            const ids = cg?.layer_ids || [];
            if (entry.mode === 'composite') {
                result.push({ id: entry.id, entryIdx: i, mode: 'composite', memberIds: ids });
            } else {
                for (const id of ids) result.push({ id, entryIdx: i });
            }
        }
    }
    return result;
}

function countSwSlots(groups, layerTree, customGroups = []) {
    return expandSwGroupEntries(groups, layerTree, customGroups).length;
}

// ================================================
// レイヤー描画（カメラ変換なし、任意の ctx に描く）
// ================================================

// クリッピングスタック合成用オフスクリーンcanvas。
// _drawPreview はドラッグ中 mousemove ごとに走るため、毎回の生成を避けてキャッシュする
let _clipTmpCanvas = null;

function renderLayersToCtx(ctxArg, layers, imageMap, config) {
    let ctx = ctxArg; // クリッピングスタック描画時にオフスクリーンへ一時スワップ可能
    const vis          = config?.visibility    || {};
    const cgList       = config?.custom_groups || [];
    const rigging      = config?.rigging       || {};
    const pose         = config?.pose          || {};
    const layerParentMap = config?.layer_parent || {};

    const cgMap = {};
    for (const cg of cgList) cgMap[cg.id] = cg;

    const cgHidden = new Set();
    function markHidden(cg) {
        for (const lid of cg.layer_ids) {
            cgHidden.add(lid);
            if (cgMap[lid]) markHidden(cgMap[lid]);
        }
    }
    for (const cg of cgList) { if (cg.visible === false) markHidden(cg); }

    // SWポイントによるグループ表示切り替え（通常のvisibilityを上書き）
    const SW_STEP = Math.PI / 6; // 30度
    for (const swLayer of (config?.sw_layers || [])) {
        for (const swInfo of (swLayer.points || [])) {
            if (!swInfo.groups?.length) continue;
            const flat = expandSwGroupEntries(swInfo.groups, layers, cgList);
            const n = flat.length;
            if (n === 0) continue;
            const angle = swInfo.angle ?? 0;
            const range = SW_STEP * n;
            const normAngle = ((angle % range) + range) % range;
            const activeSlot = Math.min(Math.floor(normAngle / SW_STEP), n - 1);
            for (let i = 0; i < n; i++) {
                const slot = flat[i];
                const ids = slot.mode === 'composite' ? slot.memberIds : [slot.id];
                if (i === activeSlot) {
                    for (const id of ids) {
                        cgHidden.delete(id);
                        if (cgMap[id]) { const unmark = g => { for (const lid of g.layer_ids) { cgHidden.delete(lid); if (cgMap[lid]) unmark(cgMap[lid]); } }; unmark(cgMap[id]); }
                    }
                } else {
                    for (const id of ids) {
                        cgHidden.add(id);
                        if (cgMap[id]) markHidden(cgMap[id]);
                    }
                }
            }
        }
    }

    function applyRigTransform(entry, rig, p) {
        const pivot = rig.r ?? rig.mr;
        if (pivot) {
            const px = entry.left + pivot.x;
            const py = entry.top  + pivot.y;
            if (p.angle) {
                ctx.translate(px, py);
                ctx.rotate(p.angle);
                ctx.translate(-px, -py);
            }
            if (p.flipX || p.flipY) {
                ctx.translate(px, py);
                ctx.scale(p.flipX ? -1 : 1, p.flipY ? -1 : 1);
                ctx.translate(-px, -py);
            }
        }
        if (p.tx || p.ty) ctx.translate(p.tx ?? 0, p.ty ?? 0);
    }

    // 祖先の累積トランスフォームを取得（描画順は変えず変換のみ伝播）
    function getAncestorChain(layerId) {
        const chain = [];
        const visited = new Set([layerId]);
        let cur = layerParentMap[layerId];
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            const rig = rigging[cur], p = pose[cur], e = imageMap[cur];
            if (rig && p && e && (p.angle || p.tx || p.ty || p.flipX || p.flipY)) chain.unshift({ entry: e, rig, p });
            cur = layerParentMap[cur];
        }
        return chain;
    }

    // 全PSDノードをIDで引けるマップ
    const nodeMap = {};
    const buildNodeMap = ns => { for (const n of ns) { nodeMap[n.id] = n; if (n.children) buildNodeMap(n.children); } };
    buildNodeMap(layers);

    // いずれかのCGのlayer_idsに属するPSDレイヤーID（CG経由でのみ描画する）
    const cgMemberIds = new Set();
    for (const cg of cgList) for (const lid of cg.layer_ids) if (!cgMap[lid]) cgMemberIds.add(lid);

    function drawLeaf(n) {
        const entry = imageMap[n.id];
        if (!entry?.img) return;
        const chain = getAncestorChain(n.id);
        const rig   = rigging[n.id], p = pose[n.id];
        const hasTf = rig && p && (p.angle || p.tx || p.ty || p.flipX || p.flipY);
        if (chain.length > 0 || hasTf) {
            ctx.save();
            for (const { entry: e, rig: r, p: pp } of chain) applyRigTransform(e, r, pp);
            if (hasTf) applyRigTransform(entry, rig, p);
            ctx.drawImage(entry.img, entry.left, entry.top, entry.width, entry.height);
            ctx.restore();
        } else {
            ctx.drawImage(entry.img, entry.left, entry.top, entry.width, entry.height);
        }
    }

    // skipCgMembers=true: PSDツリー走査時にCGメンバーをスキップ（二重描画防止）
    function renderOneNode(n, skipCgMembers) {
        if (cgHidden.has(n.id)) return;
        if (skipCgMembers && cgMemberIds.has(n.id)) return;
        const stateVis = vis[n.id];
        if (!(stateVis !== undefined ? stateVis : n.visible)) return;
        if (n.kind === "group" && n.children) {
            const rig = rigging[n.id], p = pose[n.id], entry = imageMap[n.id];
            if (rig && p && entry && (p.angle || p.tx || p.ty || p.flipX || p.flipY)) {
                ctx.save(); applyRigTransform(entry, rig, p);
                renderChildren(n.children, skipCgMembers);
                ctx.restore();
            } else {
                renderChildren(n.children, skipCgMembers);
            }
        } else {
            drawLeaf(n);
        }
    }

    // グループの子を描画。clipping=true が続く場合はスタックとして一括処理する
    function renderChildren(children, skipCgMembers) {
        let i = 0;
        while (i < children.length) {
            const base = children[i];
            const clips = [];
            let j = i + 1;
            while (j < children.length && children[j].clipping) {
                clips.push(children[j]);
                j++;
            }
            if (clips.length > 0) {
                renderClippingStack(base, clips, skipCgMembers);
            } else {
                renderOneNode(base, skipCgMembers);
            }
            i = j;
        }
    }

    // ベースレイヤー + クリッピングレイヤー群をオフスクリーンで合成して描画する。
    // source-atop によりクリッピングレイヤーをベースの不透明領域のみに表示する。
    // 各レイヤーに設定された R/MR リグは drawLeaf 経由で正常に適用される。
    function renderClippingStack(base, clipLayers, skipCgMembers) {
        if (cgHidden.has(base.id)) return;
        if (skipCgMembers && cgMemberIds.has(base.id)) return;
        const baseVis = vis[base.id];
        if (!(baseVis !== undefined ? baseVis : base.visible)) return;

        const mainCanvas = ctxArg.canvas;
        if (!_clipTmpCanvas) _clipTmpCanvas = document.createElement('canvas');
        const tmpCanvas = _clipTmpCanvas;
        if (tmpCanvas.width  !== mainCanvas.width)  tmpCanvas.width  = mainCanvas.width;
        if (tmpCanvas.height !== mainCanvas.height) tmpCanvas.height = mainCanvas.height;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.setTransform(1, 0, 0, 1, 0, 0);
        tmpCtx.clearRect(0, 0, tmpCanvas.width, tmpCanvas.height);

        // 現在のトランスフォーム（カメラ変換含む）をオフスクリーンにコピー
        const t = ctx.getTransform();
        tmpCtx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);

        // ctx をオフスクリーンに一時スワップ — drawLeaf/applyRigTransform が自動的に tmpCtx を使う
        const savedCtx = ctx;
        ctx = tmpCtx;

        drawLeaf(base);

        tmpCtx.globalCompositeOperation = 'source-atop';
        for (const clip of clipLayers) {
            if (cgHidden.has(clip.id)) continue;
            if (skipCgMembers && cgMemberIds.has(clip.id)) continue;
            const clipVis = vis[clip.id];
            if (!(clipVis !== undefined ? clipVis : clip.visible)) continue;
            drawLeaf(clip);
        }
        tmpCtx.globalCompositeOperation = 'source-over';

        ctx = savedCtx;

        // トランスフォームをリセットして 1:1 でメインcanvas に転送
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tmpCanvas, 0, 0);
        ctx.restore();
    }

    // ID列（下層→上層）を描画する。連続する通常ノードは renderChildren に
    // まとめて渡し、ルート直下やCG内でもクリッピングスタックを成立させる
    function renderIdList(ids, skipCgMembers, skipCgMemberEntries) {
        let run = [];
        const flushRun = () => { if (run.length) { renderChildren(run, skipCgMembers); run = []; } };
        for (const id of ids) {
            if (skipCgMemberEntries && cgMemberIds.has(id)) continue; // CGメンバーはCG経由で描画済み
            if (cgMap[id]) { flushRun(); renderCg(cgMap[id]); }
            else { const node = nodeMap[id]; if (node) run.push(node); }
        }
        flushRun();
    }

    // CG内のlayer_idsを逆順（末尾=下層）で描画
    function renderCg(cg) {
        if (cgHidden.has(cg.id) || cg.visible === false) return;
        renderIdList([...cg.layer_ids].reverse(), false, false);
    }

    const cgOrder = config?.cg_order;
    if (cgOrder && cgOrder.length > 0) {
        // cgOrder[0]=最上位 → 逆順で描画（下層から上層へ）
        renderIdList([...cgOrder].reverse(), true, true);
    } else {
        // フォールバック: PSD元順序（psd-toolsは下層→上層）
        renderChildren(layers, false);
    }
}

// ================================================
// layerParent 祖先チェーンと点変換ヘルパー
// ================================================
function buildAncestorChain(layerId, layerParentMap, rigging, pose, imageMap) {
    const chain = [];
    const visited = new Set([layerId]);
    let cur = layerParentMap?.[layerId];
    while (cur && !visited.has(cur)) {
        visited.add(cur);
        const rig = rigging?.[cur], p = pose?.[cur], e = imageMap?.[cur];
        if (rig && p && e && (p.angle || p.tx || p.ty || p.flipX || p.flipY)) chain.unshift({ entry: e, rig, p });
        cur = layerParentMap?.[cur];
    }
    return chain;
}

// ローカル（ワールド）座標 → 祖先トランスフォーム適用後の視覚座標
function applyChainToPoint(x, y, chain) {
    for (const { entry: e, rig: r, p } of chain) {
        const pivot = r.r ?? r.mr;
        if (pivot) {
            const px = e.left + pivot.x, py = e.top + pivot.y;
            if (p.angle) {
                const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
                const dx = x - px, dy = y - py;
                x = px + dx * cos - dy * sin;
                y = py + dx * sin + dy * cos;
            }
            if (p.flipX) x = 2 * px - x;
            if (p.flipY) y = 2 * py - y;
        }
        x += p.tx ?? 0;
        y += p.ty ?? 0;
    }
    return { x, y };
}

// 視覚座標 → ローカル（ワールド）座標（逆変換）
function inverseChainToPoint(x, y, chain) {
    for (const { entry: e, rig: r, p } of [...chain].reverse()) {
        x -= p.tx ?? 0;
        y -= p.ty ?? 0;
        const pivot = r.r ?? r.mr;
        if (pivot) {
            const px = e.left + pivot.x, py = e.top + pivot.y;
            // flip は自己逆（2回適用で元に戻る）
            if (p.flipX) x = 2 * px - x;
            if (p.flipY) y = 2 * py - y;
            if (p.angle) {
                const cos = Math.cos(-p.angle), sin = Math.sin(-p.angle);
                const dx = x - px, dy = y - py;
                x = px + dx * cos - dy * sin;
                y = py + dx * sin + dy * cos;
            }
        }
    }
    return { x, y };
}

// ================================================
// リグポイント1点の描画ヘルパー
// ================================================
function _drawRigPoint(ctx, x, y, r, fill, stroke = "#fff") {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

// ================================================
// リグラベル描画ヘルパー（PSD座標系・カメラ変換内で呼ぶ）
// ================================================
function _drawRigLabel(ctx, x, y, label, isSelected, pointSize = 1.0) {
    ctx.save();
    const fontSize = Math.max(8, Math.round(11 * pointSize));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const tw  = ctx.measureText(label).width;
    const pad = 3;
    const ly  = y - Math.round(10 * pointSize);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x - tw / 2 - pad, ly - fontSize - 2, tw + pad * 2, fontSize + 3);
    ctx.fillStyle = isSelected ? "#ffdd44" : "rgba(255,255,255,0.9)";
    ctx.fillText(label, x, ly);
    ctx.restore();
}

// ================================================
// リグオーバーレイ描画
//   mode: 'setup' | 'pose'
//   setupPointType: 'r' | 'mr' (setupモード時のみ使用)
//   selectedLayerId: 現在選択中のレイヤーID
//   showLabels: ポイント上にレイヤー名を表示するか
//   renamed: { layerId: name } の名前上書きマップ
// ================================================
function drawRigOverlay(ctx, layers, imageMap, rigging, pose, mode, selectedLayerId, setupPointType, showLabels = false, renamed = {}, layerParentMap = {}, customGroups = [], pointSize = 1.0, swLayers = [], selectedSwPointInfo = null) {
    if ((!rigging || Object.keys(rigging).length === 0) && swLayers.length === 0) return;
    const PR  = Math.round(7  * pointSize);
    const SR  = Math.round(12 * pointSize);
    const PSR = Math.round(11 * pointSize);

    function flatLayers(nodes, arr = []) {
        for (const n of nodes) { arr.push(n); if (n.children) flatLayers(n.children, arr); }
        return arr;
    }
    const allLayers = flatLayers(layers);
    for (const cg of customGroups) {
        if (rigging[cg.id] && !allLayers.some(n => n.id === cg.id)) {
            allLayers.push({ id: cg.id, name: cg.name });
        }
    }

    for (const n of allLayers) {
        const rig = rigging[n.id];
        if (!rig?.r && !rig?.mr) continue;
        const entry = imageMap?.[n.id];
        if (!entry) continue;
        const p         = pose?.[n.id] || { angle: 0, tx: 0, ty: 0 };
        const tx        = p.tx ?? 0, ty = p.ty ?? 0;
        const isSelected = n.id === selectedLayerId;

        // 祖先トランスフォームをctxに適用（子リグポイントを正しい視覚位置に表示）
        const chain = buildAncestorChain(n.id, layerParentMap, rigging, pose, imageMap);
        if (chain.length > 0) {
            ctx.save();
            for (const { entry: e, rig: r, p: pp } of chain) {
                if (pp.angle) {
                    const piv = r.r ?? r.mr;
                    if (piv) {
                        const px = e.left + piv.x, py = e.top + piv.y;
                        ctx.translate(px, py); ctx.rotate(pp.angle); ctx.translate(-px, -py);
                    }
                }
                if (pp.tx || pp.ty) ctx.translate(pp.tx ?? 0, pp.ty ?? 0);
            }
        }

        if (mode === 'setup' && isSelected) {
            // ---- セットアップモード（選択中）: 素の座標で詳細表示 ----

            // Rポイント（青）
            if (rig.r) {
                const rX = entry.left + rig.r.x;
                const rY = entry.top  + rig.r.y;
                _drawRigPoint(ctx, rX, rY, PR, "#4499ff");
                if (setupPointType === 'r') {
                    ctx.save();
                    ctx.strokeStyle = "rgba(68,153,255,0.9)";
                    ctx.lineWidth = 2.5;
                    ctx.beginPath(); ctx.arc(rX, rY, SR, 0, Math.PI * 2); ctx.stroke();
                    ctx.restore();
                }
                if (showLabels) {
                    _drawRigLabel(ctx, rX, rY, renamed?.[n.id] ?? n.name ?? String(n.id), true, pointSize);
                }
            }

            // MRポイント（赤＋オレンジ）
            if (rig.mr) {
                const sX = entry.left + rig.mr.x;
                const sY = entry.top  + rig.mr.y;

                if (rig.mr_radius > 0) {
                    const mrA = rig.mr_angle ?? 0;
                    const oX = sX + rig.mr_radius * Math.cos(mrA);
                    const oY = sY + rig.mr_radius * Math.sin(mrA);

                    // 可動範囲円（オレンジ破線）
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.strokeStyle = "rgba(255,136,0,0.5)";
                    ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.arc(sX, sY, rig.mr_radius, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]); ctx.restore();

                    // MRポイント→オレンジポイント: 赤の点線で結ぶ
                    ctx.save();
                    ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = "rgba(220,50,50,0.85)";
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(sX, sY); ctx.lineTo(oX, oY); ctx.stroke();
                    ctx.setLineDash([]); ctx.restore();
                    _drawRigPoint(ctx, oX, oY, PR, "#ff8800");
                    // 半径ラベル
                    ctx.save();
                    ctx.fillStyle = "rgba(255,160,0,0.85)";
                    ctx.font = `${Math.max(8, Math.round(10 * pointSize))}px sans-serif`;
                    ctx.textBaseline = "bottom";
                    ctx.fillText(`R: ${rig.mr_radius}`, oX + 9, oY);
                    ctx.restore();
                }

                _drawRigPoint(ctx, sX, sY, PR, "#ff3333");

                if (setupPointType === 'mr') {
                    ctx.save();
                    ctx.strokeStyle = "rgba(255,51,51,0.9)";
                    ctx.lineWidth = 2.5;
                    ctx.beginPath(); ctx.arc(sX, sY, SR, 0, Math.PI * 2); ctx.stroke();
                    ctx.restore();
                }

                if (showLabels && !rig.r) {
                    // Rポイントがない場合はMRポイントの上にラベル
                    _drawRigLabel(ctx, sX, sY, renamed?.[n.id] ?? n.name ?? String(n.id), true, pointSize);
                }
            }

        } else {
            // ---- ポーズモード・非選択セットアップ: ポーズ適用後の座標 ----

            // Rポイント（青）
            if (rig.r) {
                const rX = entry.left + rig.r.x + tx;
                const rY = entry.top  + rig.r.y + ty;
                _drawRigPoint(ctx, rX, rY, PR, "#4499ff");
                if (isSelected) {
                    ctx.save();
                    ctx.strokeStyle = "rgba(255,230,0,0.9)";
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(rX, rY, PSR, 0, Math.PI * 2); ctx.stroke();
                    ctx.restore();
                }
                if (showLabels) {
                    _drawRigLabel(ctx, rX, rY, renamed?.[n.id] ?? n.name ?? String(n.id), isSelected, pointSize);
                }
            }

            // MRポイント（赤固定 + オレンジ移動ハンドル）
            if (rig.mr) {
                const sX = entry.left + rig.mr.x;
                const sY = entry.top  + rig.mr.y;
                const oX = sX + tx;
                const oY = sY + ty;

                if (rig.mr_radius > 0) {
                    // 可動範囲円（オレンジ破線）
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.strokeStyle = "rgba(255,136,0,0.4)";
                    ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.arc(sX, sY, rig.mr_radius, 0, Math.PI * 2); ctx.stroke();
                    ctx.setLineDash([]); ctx.restore();

                    // MR→オレンジ: 赤の点線
                    ctx.save();
                    ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = "rgba(220,50,50,0.85)";
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(sX, sY); ctx.lineTo(oX, oY); ctx.stroke();
                    ctx.setLineDash([]); ctx.restore();

                    _drawRigPoint(ctx, oX, oY, PR, "#ff8800");
                }

                _drawRigPoint(ctx, sX, sY, PR, "#ff3333");
                if (isSelected && !rig.r) {
                    ctx.save();
                    ctx.strokeStyle = "rgba(255,230,0,0.9)";
                    ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.arc(sX, sY, PSR, 0, Math.PI * 2); ctx.stroke();
                    ctx.restore();
                }
                if (showLabels && !rig.r) {
                    _drawRigLabel(ctx, sX, sY, renamed?.[n.id] ?? n.name ?? String(n.id), isSelected, pointSize);
                }
            }
        }

        // flip インジケーター（↔/↕）
        if (p.flipX || p.flipY) {
            const pivot = rig.r ?? rig.mr;
            if (pivot) {
                const isSetupSelected = (mode === 'setup' && isSelected);
                const indX = entry.left + pivot.x + (isSetupSelected ? 0 : tx);
                const indY = entry.top  + pivot.y + (isSetupSelected ? 0 : ty);
                const label = (p.flipX && p.flipY) ? "↔↕" : p.flipX ? "↔" : "↕";
                ctx.save();
                ctx.font = `bold ${Math.max(10, Math.round(13 * pointSize))}px sans-serif`;
                ctx.fillStyle = "rgba(255,220,0,0.95)";
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillText(label, indX, indY + Math.round(10 * pointSize));
                ctx.restore();
            }
        }

        // 祖先トランスフォームを元に戻す
        if (chain.length > 0) ctx.restore();
    }

    // ---- SWポイント描画 ----
    const SW_STEP = Math.PI / 6; // 30度
    for (const swLayer of swLayers) {
        for (const swInfo of (swLayer.points || [])) {
            const oX = swInfo.x ?? 0;
            const oY = swInfo.y ?? 0;
            const radius = swInfo.radius ?? 80;
            const angle  = swInfo.angle  ?? 0;
            const hX = oX + radius * Math.cos(angle);
            const hY = oY + radius * Math.sin(angle);
            const isSelected = selectedSwPointInfo?.swLayerId === swLayer.id
                             && selectedSwPointInfo?.pointId === swInfo.id;

            // グループインデックス計算（PSDフォルダ/カスタムグループ展開後のスロット数を使用）
            const flat = expandSwGroupEntries(swInfo.groups || [], layers, customGroups);
            const n = flat.length;
            let activeIdx = 0;
            if (n > 0) {
                const range = SW_STEP * n;
                const normAngle = ((angle % range) + range) % range;
                activeIdx = Math.min(Math.floor(normAngle / SW_STEP), n - 1);
            }

            // セットアップモード選択中: 可動範囲弧を表示
            if (mode === 'setup' && isSelected && n > 0) {
                ctx.save();
                ctx.strokeStyle = "rgba(80,200,80,0.4)";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.arc(oX, oY, radius, 0, SW_STEP * n);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();

                // 各ステップの目盛り線
                for (let i = 0; i <= n; i++) {
                    const a = SW_STEP * i;
                    ctx.save();
                    ctx.strokeStyle = i === activeIdx || i === (activeIdx + 1) ? "rgba(80,220,80,0.8)" : "rgba(80,180,80,0.4)";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(oX + (radius - 8) * Math.cos(a), oY + (radius - 8) * Math.sin(a));
                    ctx.lineTo(oX + (radius + 2) * Math.cos(a), oY + (radius + 2) * Math.sin(a));
                    ctx.stroke();
                    ctx.restore();
                }
            }

            // 緑の線（原点→ハンドル）
            ctx.save();
            ctx.strokeStyle = "#44cc44";
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(oX, oY); ctx.lineTo(hX, hY); ctx.stroke();
            ctx.restore();

            // 選択リング
            if (isSelected) {
                ctx.save();
                ctx.strokeStyle = "rgba(255,230,0,0.9)";
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(oX, oY, Math.round(11 * pointSize), 0, Math.PI * 2); ctx.stroke();
                ctx.restore();
            }

            // 緑の原点
            _drawRigPoint(ctx, oX, oY, Math.round(7 * pointSize), "#22aa22", "#fff");

            // 水色のハンドル
            _drawRigPoint(ctx, hX, hY, Math.round(7 * pointSize), "#44cccc", "#fff");

            // グループ番号を水色ハンドルの中に表示
            if (n > 0) {
                ctx.save();
                ctx.fillStyle = "#fff";
                ctx.font = `bold ${Math.max(7, Math.round(9 * pointSize))}px sans-serif`;
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(String(activeIdx + 1), hX, hY);
                ctx.restore();
            }

            // SW名ラベル
            if (swInfo.name) {
                _drawRigLabel(ctx, oX, oY, swInfo.name, isSelected, pointSize);
            }
        }
    }
}

// ================================================
// リグポイントのヒットテスト（PSD座標）
//   返り値: null | { layerId, type: 'r'|'mr'|'orange' }
// ================================================
function hitTestRig(wx, wy, layers, imageMap, rigging, pose, mode, zoom, layerParentMap = {}, customGroups = [], pointSize = 1.0, swLayers = []) {
    const HIT_R = 14 / zoom * pointSize;

    function flatLayers(nodes, arr = []) {
        for (const n of nodes) { arr.push(n); if (n.children) flatLayers(n.children, arr); }
        return arr;
    }
    const allLayers = flatLayers(layers);
    for (const cg of customGroups) {
        if (rigging[cg.id] && !allLayers.some(n => n.id === cg.id)) {
            allLayers.push({ id: cg.id, name: cg.name });
        }
    }

    let bestDist = Infinity, bestHit = null;
    for (const n of [...allLayers].reverse()) {
        const rig = rigging?.[n.id];
        if (!rig?.r && !rig?.mr) continue;
        const entry = imageMap?.[n.id];
        if (!entry) continue;
        const p = pose?.[n.id] || { tx: 0, ty: 0 };
        const tx = p.tx ?? 0, ty = p.ty ?? 0;

        // 祖先トランスフォームを適用した視覚座標でヒットテスト
        const chain = buildAncestorChain(n.id, layerParentMap, rigging, pose, imageMap);
        const toVis = (x, y) => chain.length > 0 ? applyChainToPoint(x, y, chain) : { x, y };

        if (mode === 'setup') {
            if (rig.r) {
                const { x: rX, y: rY } = toVis(entry.left + rig.r.x, entry.top + rig.r.y);
                const d1 = Math.hypot(wx - rX, wy - rY);
                if (d1 < HIT_R && d1 < bestDist) { bestDist = d1; bestHit = { layerId: n.id, type: 'r' }; }
            }
            if (rig.mr) {
                const { x: sX, y: sY } = toVis(entry.left + rig.mr.x, entry.top + rig.mr.y);
                const d2 = Math.hypot(wx - sX, wy - sY);
                if (d2 < HIT_R && d2 < bestDist) { bestDist = d2; bestHit = { layerId: n.id, type: 'mr' }; }
                if (rig.mr_radius > 0) {
                    const mrA = rig.mr_angle ?? 0;
                    const { x: oX, y: oY } = toVis(
                        entry.left + rig.mr.x + rig.mr_radius * Math.cos(mrA),
                        entry.top  + rig.mr.y + rig.mr_radius * Math.sin(mrA)
                    );
                    const d3 = Math.hypot(wx - oX, wy - oY);
                    if (d3 < HIT_R && d3 < bestDist) { bestDist = d3; bestHit = { layerId: n.id, type: 'orange' }; }
                }
            }
        } else {
            // ポージング: R=ポーズ後座標、MR=固定座標・orange=MR+平行移動
            if (rig.r) {
                const { x: rX, y: rY } = toVis(entry.left + rig.r.x + tx, entry.top + rig.r.y + ty);
                const d1 = Math.hypot(wx - rX, wy - rY);
                if (d1 < HIT_R && d1 < bestDist) { bestDist = d1; bestHit = { layerId: n.id, type: 'r' }; }
            }
            if (rig.mr) {
                const { x: sX, y: sY } = toVis(entry.left + rig.mr.x, entry.top + rig.mr.y);
                if (rig.mr_radius > 0) {
                    const { x: oX, y: oY } = toVis(entry.left + rig.mr.x + tx, entry.top + rig.mr.y + ty);
                    const d3 = Math.hypot(wx - oX, wy - oY);
                    if (d3 < HIT_R && d3 < bestDist) { bestDist = d3; bestHit = { layerId: n.id, type: 'orange' }; }
                }
                const d2 = Math.hypot(wx - sX, wy - sY);
                if (d2 < HIT_R && d2 < bestDist) { bestDist = d2; bestHit = { layerId: n.id, type: 'mr' }; }
            }
        }
    }
    // SWポイントのヒットテスト（ハンドル＋セットアップ時は原点も）
    for (const swLayer of swLayers) {
        for (const swInfo of (swLayer.points || [])) {
            const oX = swInfo.x ?? 0;
            const oY = swInfo.y ?? 0;
            const radius = swInfo.radius ?? 80;
            const angle  = swInfo.angle  ?? 0;
            const hX = oX + radius * Math.cos(angle);
            const hY = oY + radius * Math.sin(angle);

            // ハンドル（水色点）は両モードで操作可能
            const dh = Math.hypot(wx - hX, wy - hY);
            if (dh < HIT_R && dh < bestDist) {
                bestDist = dh;
                bestHit = { swLayerId: swLayer.id, swPointId: swInfo.id, type: 'sw_handle' };
            }
            // 原点（緑点）はセットアップモードのみ移動可能
            if (mode === 'setup') {
                const do_ = Math.hypot(wx - oX, wy - oY);
                if (do_ < HIT_R && do_ < bestDist) {
                    bestDist = do_;
                    bestHit = { swLayerId: swLayer.id, swPointId: swInfo.id, type: 'sw_origin' };
                }
            }
        }
    }

    return bestHit;
}

// ================================================
// モーダルプレビュー描画（canvas ごとセットアップ）
// ================================================
function drawPreview(canvas, psdW, psdH, layers, imageMap, config) {
    if (!canvas || !psdW || !psdH) return;
    canvas.width  = psdW;
    canvas.height = psdH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, psdW, psdH);

    const gs = Math.max(8, Math.round(psdW / 40));
    for (let y = 0; y < psdH; y += gs) {
        for (let x = 0; x < psdW; x += gs) {
            ctx.fillStyle = ((Math.floor(x / gs) + Math.floor(y / gs)) % 2 === 0) ? "#2a2a2a" : "#3a3a3a";
            ctx.fillRect(x, y, gs, gs);
        }
    }
    renderLayersToCtx(ctx, layers, imageMap, config);
}

// ワールド座標 → キャンバス座標変換
function worldToCanvas(wx, wy, cam, W, H) {
    return {
        x: W / 2 + cam.zoom * (wx + cam.x - W / 2),
        y: H / 2 + cam.zoom * (wy + cam.y - H / 2),
    };
}

// ================================================
// 出力フレーム計算
//   output_width/output_height のアスペクト比に合わせた
//   プレビューキャンバス内の切り取り矩形を返す
// ================================================
function computeOutputFrame(node) {
    if (!node._nodeCanvas) return null;
    const srcW = node._nodeCanvas.width;
    const srcH = node._nodeCanvas.height;
    const outW = findWidget(node, "output_width")?.value  || 512;
    const outH = findWidget(node, "output_height")?.value || 512;
    const outAspect = outW / outH;
    const srcAspect = srcW / srcH;
    let fw, fh;
    if (outAspect >= srcAspect) {
        fw = srcW;
        fh = Math.round(srcW / outAspect);
    } else {
        fh = srcH;
        fw = Math.round(srcH * outAspect);
    }
    const fx = Math.round((srcW - fw) / 2);
    const fy = Math.round((srcH - fh) / 2);
    return { fx, fy, fw, fh, srcW, srcH, outW, outH };
}

// ================================================
// カスタムグループ用の仮想エントリを含むimageMapを返す
// ================================================
function getEffectiveImageMap(node, config) {
    const base = node._layerImages || {};
    const psdW = node._psdW || 0;
    const psdH = node._psdH || 0;
    const cgList = config?.custom_groups || [];
    if (!cgList.length) return base;
    const map = Object.assign(Object.create(null), base);
    for (const cg of cgList) {
        if (!(cg.id in map)) {
            map[cg.id] = { img: null, objUrl: null, isCgLayer: true, left: 0, top: 0, width: psdW, height: psdH };
        }
    }
    return map;
}

// ================================================
// ノード内プレビューキャンバス描画（カメラ変換あり）
// ================================================
function drawNodeCanvas(node, { skipFrameLabel = false, targetCanvas = null } = {}) {
    const canvas = targetCanvas || node._nodeCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // background_image 入力ポートの接続状態を確認
    const bgLinked = !!(node.inputs?.find(i => i.name === 'background_image')?.link);

    // 背景描画（優先順：ローカル画像 > ローカル色 > 接続インジケーター > チェッカー）
    if (node._bgImage) {
        const img = node._bgImage;
        const imgAsp = img.naturalWidth / img.naturalHeight;
        const canAsp = W / H;
        let bw, bh, bx, by;
        if (imgAsp > canAsp) { bw = W; bh = W / imgAsp; } else { bh = H; bw = H * imgAsp; }
        bx = (W - bw) / 2; by = (H - bh) / 2;
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, bx, by, bw, bh);
    } else if (node._bgColorEnabled && node._bgColor) {
        ctx.fillStyle = node._bgColor;
        ctx.fillRect(0, 0, W, H);
    } else if (bgLinked) {
        // 接続された背景画像（内容はPython側で合成。キャンバスにはインジケーター表示）
        ctx.fillStyle = "#141f14";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "rgba(68,204,68,0.12)";
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.fillStyle = "rgba(68,204,68,0.6)";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(t("externalBgConnected"), W / 2, H / 2);
        ctx.fillText(t("queuePromptToApply"), W / 2, H / 2 + 18);
        ctx.restore();
    } else {
        // チェッカー背景（透明時のデフォルト）
        const gs = 12;
        for (let y = 0; y < H; y += gs) {
            for (let x = 0; x < W; x += gs) {
                ctx.fillStyle = ((Math.floor(x / gs) + Math.floor(y / gs)) % 2 === 0) ? "#2a2a2a" : "#3a3a3a";
                ctx.fillRect(x, y, gs, gs);
            }
        }
    }

    const cam = node._camera || { x: 0, y: 0, zoom: 1, roll: 0 };

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(cam.roll || 0);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);

    let _config = {};
    if (node._layerImages && node._psdW && node._psdH && node._psdLayers) {
        try { _config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}
        const _imgMap = getEffectiveImageMap(node, _config);
        renderLayersToCtx(ctx, node._psdLayers, _imgMap, _config);

        // リグオーバーレイ（ポージングモード）
        if (_config.rigging || _config.sw_layers?.length) {
            drawRigOverlay(
                ctx, node._psdLayers, _imgMap,
                _config.rigging || {}, _config.pose, 'pose',
                node._rigSelectedLayerId ?? null, null,
                node._showRigLabels ?? false, _config.renamed || {}, _config.layer_parent || {},
                _config.custom_groups || [], node._rigPointSize ?? 1.0,
                _config.sw_layers || [], node._selectedSwPointInfo ?? null
            );
        }
    } else if (node._compositeImg && node._psdW && node._psdH) {
        ctx.drawImage(node._compositeImg, 0, 0, node._psdW, node._psdH);
    }

    // ---- PSD境界オーバーレイ（参考用・破線）ctx変換内で描画してロール対応 ----
    if (node._psdW && node._psdH) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,100,0.5)";
        ctx.lineWidth   = 1 / cam.zoom;
        ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
        ctx.strokeRect(0, 0, node._psdW, node._psdH);
        ctx.restore();
    }

    ctx.restore();

    // ---- 出力フレームオーバーレイ（output_width × output_height のアスペクト比） ----
    const frame = computeOutputFrame(node);
    if (frame) {
        const { fx, fy, fw, fh } = frame;

        // フレーム外を暗幕（フレーム内は出力範囲）
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        if (fy > 0)           ctx.fillRect(0,      0,      W,        fy);
        if (fy + fh < H)      ctx.fillRect(0,      fy + fh, W,       H - (fy + fh));
        if (fx > 0)           ctx.fillRect(0,      fy,     fx,       fh);
        if (fx + fw < W)      ctx.fillRect(fx + fw, fy,    W - (fx + fw), fh);

        // フレーム枠（白い線）
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);

        // 角マーカー（L字）
        const m = 12;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth   = 2.5;
        for (const [cx, cy, dx, dy] of [
            [fx,      fy,      1,  1],
            [fx + fw, fy,     -1,  1],
            [fx,      fy + fh, 1, -1],
            [fx + fw, fy + fh,-1, -1],
        ]) {
            ctx.beginPath();
            ctx.moveTo(cx + dx * m, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy + dy * m);
            ctx.stroke();
        }

        // 出力サイズをフレーム内に表示
        if (!skipFrameLabel) {
            const label = `${frame.outW} × ${frame.outH}`;
            ctx.font         = "bold 11px sans-serif";
            ctx.textAlign    = "right";
            ctx.textBaseline = "bottom";
            ctx.fillStyle    = "rgba(0,0,0,0.6)";
            ctx.fillRect(fx + fw - 82, fy + fh - 18, 80, 16);
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.fillText(label, fx + fw - 4, fy + fh - 3);
        }
    }

    if (node._previewStatusEl) node._previewStatusEl.textContent = "";
}

// サムネイル用キャプチャ：ラベルオフで描画→取得→状態を復元
function captureThumbFromNode(node, thumbW, thumbH) {
    const canvas = node._nodeCanvas;
    if (!canvas) return null;
    const wasShowing = node._showRigLabels;
    node._showRigLabels = false;
    drawNodeCanvas(node, { skipFrameLabel: true });
    const fr = computeOutputFrame(node);
    const w = thumbW || 140;
    const h = thumbH !== undefined ? thumbH : (fr ? Math.max(1, Math.round(w * fr.fh / fr.fw)) : 88);
    const tc = document.createElement("canvas"); tc.width = w; tc.height = h;
    const tx = tc.getContext("2d");
    if (fr) tx.drawImage(canvas, fr.fx, fr.fy, fr.fw, fr.fh, 0, 0, w, h);
    else    tx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
    const result = tc.toDataURL("image/png");
    node._showRigLabels = wasShowing;
    drawNodeCanvas(node);
    return result;
}

// ================================================
// カメラ初期状態をPSDサイズに合わせてセット
// ================================================
function setDefaultCamera(node) {
    if (!node._psdW || !node._psdH || !node._nodeCanvas) return;
    const W = node._nodeCanvas.width;
    const H = node._nodeCanvas.height;
    const zoom = Math.min(W / node._psdW, H / node._psdH) * 0.95;
    const cam = {
        x: (W - node._psdW) / 2,
        y: (H - node._psdH) / 2,
        zoom,
        roll: 0,
    };
    node._camera        = { ...cam };
    node._defaultCamera = { ...cam };
}

function resetNodeCamera(node) {
    const dc = node._defaultCamera || { x: 0, y: 0, zoom: 1 };
    node._camera = { ...dc };
    drawNodeCanvas(node);
}

function resetNodePose(node) {
    let config = {};
    try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}
    if (!config.rigging) return;
    config.pose = {};
    for (const id of Object.keys(config.rigging)) {
        config.pose[id] = { angle: 0, tx: 0, ty: 0 };
    }
    const w = findWidget(node, "layer_config");
    if (w) w.value = JSON.stringify(config);
    drawNodeCanvas(node);
}

// ================================================
// ノードプレビューを更新
// ================================================
function _setNodePreview(node, config) {
    const filename = node._psdFilename || findWidget(node, "psd_filename")?.value;
    if (!filename || !node._nodeCanvas) return;
    if (node._previewStatusEl) node._previewStatusEl.textContent = t("loading");

    const params = new URLSearchParams({
        filename,
        config: JSON.stringify(config),
        width: String(node._nodeCanvas.width * 2), // 高解像度で取得
        _t: Date.now(),
    });
    const img = new Image();
    img.onload = () => {
        node._compositeImg = img;
        drawNodeCanvas(node);
    };
    img.onerror = () => {
        if (node._previewStatusEl) node._previewStatusEl.textContent = t("previewError");
    };
    img.src = `/psd_loader/preview?${params}`;
}

async function refreshNodePreview(node) {
    const filename = node._psdFilename || findWidget(node, "psd_filename")?.value;
    if (!filename || !node._nodeCanvas) return;

    let config = {};
    try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}

    if (node._layerImages && node._psdW && node._psdH && node._psdLayers) {
        drawNodeCanvas(node);
        return;
    }
    _setNodePreview(node, config);
}

// ================================================
// PSDアップロード処理
// ================================================
async function uploadPSD(file, node) {
    if (!file?.name.toLowerCase().endsWith(".psd")) {
        alert(t("onlyPsdAllowed"));
        return;
    }

    const form = new FormData();
    form.append("file", file);

    try {
        const res  = await fetch("/psd_loader/upload", { method: "POST", body: form });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const fw = findWidget(node, "psd_filename");
        if (fw) fw.value = data.filename;

        node._psdFilename = data.filename;
        node._psdLayers   = data.layers;
        node._psdW        = data.width;
        node._psdH        = data.height;
        node._layerImages = null;
        node._compositeImg = null;

        if (node._psdBtn) node._psdBtn.textContent = `📂 ${data.filename}`;

        setDefaultCamera(node);
        await refreshNodePreview(node);
    } catch (err) {
        alert(t("uploadError", err.message));
    }
}

// ================================================
// キャプチャ（出力フレーム領域をoutW×outHに変換して出力）
// ================================================
function captureNode(node) {
    const imgWidget = findWidget(node, "image_data");
    if (!imgWidget || !node._nodeCanvas) return false;
    if (!node._psdW || !node._psdH) {
        if (node._previewStatusEl) node._previewStatusEl.textContent = t("psdNotSelected");
        return false;
    }

    const frame = computeOutputFrame(node);
    if (!frame) return false;
    const { fx, fy, fw, fh, srcW, srcH, outW, outH } = frame;
    const cam = node._camera;

    const tmp    = document.createElement("canvas");
    tmp.width    = outW;
    tmp.height   = outH;
    const tmpCtx = tmp.getContext("2d");

    // 背景を先に描画（カメラ変換前）
    if (node._bgImage) {
        const img = node._bgImage;
        const imgAsp = img.naturalWidth / img.naturalHeight;
        const outAsp = outW / outH;
        let bw, bh, bx, by;
        if (imgAsp > outAsp) { bw = outW; bh = outW / imgAsp; } else { bh = outH; bw = outH * imgAsp; }
        bx = (outW - bw) / 2; by = (outH - bh) / 2;
        tmpCtx.fillStyle = "#000";
        tmpCtx.fillRect(0, 0, outW, outH);
        tmpCtx.drawImage(img, bx, by, bw, bh);
    } else if (node._bgColorEnabled && node._bgColor) {
        tmpCtx.fillStyle = node._bgColor;
        tmpCtx.fillRect(0, 0, outW, outH);
    }

    // プレビューのフレーム領域(fw×fh)をoutW×outHにマッピング
    // world → preview: px = srcW/2 + zoom*(wx + camX - srcW/2)
    // preview → frame: kx = px - fx    (fx = (srcW-fw)/2 なので srcW/2 - fx = fw/2)
    // frame → output:  ox = kx * outW/fw
    // Combined:        ox = outW/2 + (outW/fw) * zoom * (wx + camX - srcW/2)
    const scaleOut = outW / fw; // = outH / fh（出力アスペクト比 = フレームアスペクト比）

    tmpCtx.save();
    tmpCtx.translate(outW / 2, outH / 2);
    tmpCtx.rotate(cam.roll || 0);
    tmpCtx.scale(cam.zoom * scaleOut, cam.zoom * scaleOut);
    tmpCtx.translate(-srcW / 2 + cam.x, -srcH / 2 + cam.y);

    let config = {};
    try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}

    if (node._layerImages && node._psdLayers) {
        renderLayersToCtx(tmpCtx, node._psdLayers, getEffectiveImageMap(node, config), config);
    } else if (node._compositeImg) {
        tmpCtx.drawImage(node._compositeImg, 0, 0, node._psdW, node._psdH);
    }

    tmpCtx.restore();

    imgWidget.value = tmp.toDataURL("image/png");
    return true;
}

// ================================================
// 出力キャンバスへの共通レンダリング（captureNode・動画エクスポート共用）
// ================================================
function renderToOutputCanvas(node, destCanvas) {
    const frame = computeOutputFrame(node);
    if (!frame) return false;
    const { fw, fh, srcW, srcH, outW, outH } = frame;
    const cam = node._camera;

    if (destCanvas.width  !== outW) destCanvas.width  = outW;
    if (destCanvas.height !== outH) destCanvas.height = outH;

    const ctx = destCanvas.getContext("2d");
    ctx.clearRect(0, 0, outW, outH);

    if (node._bgImage) {
        const img    = node._bgImage;
        const imgAsp = img.naturalWidth / img.naturalHeight;
        const outAsp = outW / outH;
        let bw, bh, bx, by;
        if (imgAsp > outAsp) { bw = outW; bh = outW / imgAsp; } else { bh = outH; bw = outH * imgAsp; }
        bx = (outW - bw) / 2; by = (outH - bh) / 2;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, bx, by, bw, bh);
    } else if (node._bgColorEnabled && node._bgColor) {
        ctx.fillStyle = node._bgColor;
        ctx.fillRect(0, 0, outW, outH);
    }

    const scaleOut = outW / fw;
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate(cam.roll || 0);
    ctx.scale(cam.zoom * scaleOut, cam.zoom * scaleOut);
    ctx.translate(-srcW / 2 + cam.x, -srcH / 2 + cam.y);

    let config = {};
    try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}

    if (node._layerImages && node._psdLayers) {
        renderLayersToCtx(ctx, node._psdLayers, getEffectiveImageMap(node, config), config);
    } else if (node._compositeImg) {
        ctx.drawImage(node._compositeImg, 0, 0, node._psdW, node._psdH);
    }

    ctx.restore();
    return true;
}

// ================================================
// キーフレームシステム
// ================================================

function _kfLerp(a, b, t) { return a + (b - a) * t; }

// 角度の最短経路補間（-π〜π の範囲）
function _kfLerpAngle(a, b, t) {
    let d = b - a;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
}

// 指定フレームでのポーズを補間して返す
function _kfGetInterpolatedState(keyframes, frame) {
    if (!keyframes.length) return null;

    let before = null, after = null;
    for (const kf of keyframes) {
        if (kf.frame <= frame) before = kf;
        if (kf.frame >= frame && !after) after = kf;
    }

    if (!before && !after) return null;
    if (!before) return after;
    if (!after)  return before;
    if (before.frame === after.frame) return before;

    const t = (frame - before.frame) / (after.frame - before.frame);

    // pose 補間
    const pose    = {};
    const poseIds = new Set([...Object.keys(before.pose || {}), ...Object.keys(after.pose || {})]);
    for (const id of poseIds) {
        const a = before.pose?.[id] || { angle: 0, tx: 0, ty: 0 };
        const b = after.pose?.[id]  || { angle: 0, tx: 0, ty: 0 };
        pose[id] = {
            angle: _kfLerpAngle(a.angle ?? 0, b.angle ?? 0, t),
            tx:    _kfLerp(a.tx ?? 0, b.tx ?? 0, t),
            ty:    _kfLerp(a.ty ?? 0, b.ty ?? 0, t),
            flipX: t < 0.5 ? (a.flipX ?? false) : (b.flipX ?? false),
            flipY: t < 0.5 ? (a.flipY ?? false) : (b.flipY ?? false),
        };
    }

    // SW角度補間
    const sw_angles = {};
    const swIds = new Set([...Object.keys(before.sw_angles || {}), ...Object.keys(after.sw_angles || {})]);
    for (const id of swIds) {
        sw_angles[id] = _kfLerpAngle(before.sw_angles?.[id] ?? 0, after.sw_angles?.[id] ?? 0, t);
    }

    // visibility はステップ（before を使用）
    const visibility = JSON.parse(JSON.stringify(before.visibility || {}));

    // camera 補間：ポーズ KF とは独立してカメラ付き KF だけを探して補間
    let camera = null;
    {
        let camBefore = null, camAfter = null;
        for (const kf of keyframes) {
            if (kf.camera && kf.frame <= frame) camBefore = kf;
            if (kf.camera && kf.frame >= frame && !camAfter) camAfter = kf;
        }
        if (camBefore || camAfter) {
            if (!camBefore) {
                camera = { ...camAfter.camera };
            } else if (!camAfter) {
                camera = { ...camBefore.camera };
            } else if (camBefore.frame === camAfter.frame) {
                camera = { ...camBefore.camera };
            } else {
                const tc = (frame - camBefore.frame) / (camAfter.frame - camBefore.frame);
                const a  = camBefore.camera;
                const b  = camAfter.camera;
                camera = {
                    zoom: _kfLerp(      a.zoom ?? 1, b.zoom ?? 1, tc),
                    x:    _kfLerp(      a.x    ?? 0, b.x    ?? 0, tc),
                    y:    _kfLerp(      a.y    ?? 0, b.y    ?? 0, tc),
                    roll: _kfLerpAngle( a.roll ?? 0, b.roll ?? 0, tc),
                };
            }
        }
    }

    return { pose, sw_angles, visibility, camera };
}

// 指定フレームにシーク（layer_config を更新して再描画）
// silent=true のとき node canvas の描画をスキップ（動画エクスポート時）
function seekToFrame(node, frame, { silent = false } = {}) {
    const total = Math.max(1, node._kfTotalFrames || 60);
    frame = Math.max(0, Math.min(total - 1, frame));
    node._kfCurrentFrame = frame;
    if (node._kfCurrentFrameEl) node._kfCurrentFrameEl.value = frame;

    const kfs = node._keyframes || [];
    if (kfs.length > 0) {
        const state = _kfGetInterpolatedState(kfs, frame);
        if (state) {
            const w = findWidget(node, "layer_config");
            if (w) {
                let config = {};
                try { config = JSON.parse(w.value || "{}"); } catch (_) {}

                if (state.pose !== undefined) {
                    config.pose = JSON.parse(JSON.stringify(state.pose));
                }

                if (state.sw_angles && Object.keys(state.sw_angles).length > 0) {
                    for (const swl of (config.sw_layers || [])) {
                        for (const pt of (swl.points || [])) {
                            if (pt.id in state.sw_angles) pt.angle = state.sw_angles[pt.id];
                        }
                    }
                }

                if (state.visibility && Object.keys(state.visibility).length > 0) {
                    config.visibility = config.visibility || {};
                    Object.assign(config.visibility, state.visibility);
                }

                w.value = JSON.stringify(config);
            }

            // カメラ補間値を適用（silent でも WebM エクスポートが node._camera を参照するため常に適用）
            if (state.camera && node._camera) {
                node._camera.zoom = state.camera.zoom;
                node._camera.x    = state.camera.x;
                node._camera.y    = state.camera.y;
                node._camera.roll = state.camera.roll;
            }
        }
    }

    if (!silent) drawNodeCanvas(node);
    updateTimelineCanvas(node);
}

// 現在フレームにキーフレームを追加/上書き
function addKeyframeAtCurrentFrame(node) {
    const w = findWidget(node, "layer_config");
    if (!w) return;
    let config = {};
    try { config = JSON.parse(w.value || "{}"); } catch (_) {}

    const frame = node._kfCurrentFrame || 0;

    const sw_angles = {};
    for (const swl of (config.sw_layers || [])) {
        for (const pt of (swl.points || [])) {
            sw_angles[pt.id] = pt.angle ?? 0;
        }
    }

    // 同フレームに既存 KF があればカメラデータを引き継ぐ
    const existingKf = (node._keyframes || []).find(k => k.frame === frame);
    const kf = {
        frame,
        pose:       JSON.parse(JSON.stringify(config.pose       || {})),
        sw_angles,
        visibility: JSON.parse(JSON.stringify(config.visibility || {})),
    };
    if (existingKf?.camera) kf.camera = existingKf.camera;

    node._keyframes = (node._keyframes || []).filter(k => k.frame !== frame);
    node._keyframes.push(kf);
    node._keyframes.sort((a, b) => a.frame - b.frame);

    // layer_config に永続化
    config.keyframes = JSON.parse(JSON.stringify(node._keyframes));
    w.value = JSON.stringify(config);

    updateTimelineCanvas(node);
}

// 現在フレームのポーズキーフレームを削除（camera フィールドは保持。両方なければエントリ削除）
function deleteKeyframeAtCurrentFrame(node) {
    const frame = node._kfCurrentFrame || 0;
    node._keyframes = (node._keyframes || []).map(k => {
        if (k.frame !== frame) return k;
        // ポーズ系フィールドを除去し camera だけ残す
        if (k.camera) return { frame: k.frame, camera: k.camera };
        return null; // camera もなければエントリ削除
    }).filter(Boolean);

    const w = findWidget(node, "layer_config");
    if (w) {
        let config = {};
        try { config = JSON.parse(w.value || "{}"); } catch (_) {}
        config.keyframes = JSON.parse(JSON.stringify(node._keyframes));
        w.value = JSON.stringify(config);
    }

    updateTimelineCanvas(node);
}

// 現在フレームにカメラをキーフレーム登録（既存 KF があれば camera フィールドを上書き、なければ新規エントリ）
function addCameraKeyframeAtCurrentFrame(node) {
    const cam = node._camera;
    if (!cam) return;
    const frame = node._kfCurrentFrame || 0;
    const camSnap = { zoom: cam.zoom ?? 1, x: cam.x ?? 0, y: cam.y ?? 0, roll: cam.roll ?? 0 };

    const existing = (node._keyframes || []).find(k => k.frame === frame);
    if (existing) {
        existing.camera = camSnap;
    } else {
        node._keyframes = node._keyframes || [];
        node._keyframes.push({ frame, camera: camSnap });
        node._keyframes.sort((a, b) => a.frame - b.frame);
    }

    const w = findWidget(node, "layer_config");
    if (w) {
        let config = {};
        try { config = JSON.parse(w.value || "{}"); } catch (_) {}
        config.keyframes = JSON.parse(JSON.stringify(node._keyframes));
        w.value = JSON.stringify(config);
    }
    updateTimelineCanvas(node);
}

// 現在フレームのカメラキーフレームを削除（ポーズデータは保持。KF 自体が空になれば削除）
function deleteCameraKeyframeAtCurrentFrame(node) {
    const frame = node._kfCurrentFrame || 0;
    node._keyframes = (node._keyframes || []).map(k => {
        if (k.frame !== frame) return k;
        const { camera, ...rest } = k;
        return rest;
    }).filter(k => k.camera !== undefined || Object.keys(k.pose || {}).length > 0 || Object.keys(k.sw_angles || {}).length > 0 || Object.keys(k.visibility || {}).length > 0);

    const w = findWidget(node, "layer_config");
    if (w) {
        let config = {};
        try { config = JSON.parse(w.value || "{}"); } catch (_) {}
        config.keyframes = JSON.parse(JSON.stringify(node._keyframes));
        w.value = JSON.stringify(config);
    }
    updateTimelineCanvas(node);
}

// キーフレームを別フレームに移動（ポーズ・カメラ一緒に移動。移動先に既存 KF があれば上書き）
function moveKeyframe(node, fromFrame, toFrame) {
    if (fromFrame === toFrame) return;
    const movingKf = (node._keyframes || []).find(k => k.frame === fromFrame);
    if (!movingKf) return;
    node._keyframes = node._keyframes.filter(k => k.frame !== fromFrame && k.frame !== toFrame);
    movingKf.frame = toFrame;
    node._keyframes.push(movingKf);
    node._keyframes.sort((a, b) => a.frame - b.frame);
    const w = findWidget(node, "layer_config");
    if (w) {
        let cfg = {}; try { cfg = JSON.parse(w.value || "{}"); } catch (_) {}
        cfg.keyframes = JSON.parse(JSON.stringify(node._keyframes));
        w.value = JSON.stringify(cfg);
    }
    updateTimelineCanvas(node);
}

// タイムラインキャンバスを再描画
function updateTimelineCanvas(node) {
    const canvas = node._kfTimelineCanvas;
    if (!canvas) return;

    const ctx   = canvas.getContext("2d");
    const W     = canvas.width, H = canvas.height;
    const total = Math.max(2, node._kfTotalFrames || 60);
    const cur   = node._kfCurrentFrame || 0;
    const kfs   = node._keyframes || [];

    ctx.clearRect(0, 0, W, H);

    // 背景
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, W, H);

    // トラックライン
    const trackY = Math.round(H / 2);
    ctx.fillStyle = "#313244";
    ctx.fillRect(8, trackY - 2, W - 16, 4);

    // キーフレームダイヤモンド（ポーズのみ:黄、カメラのみ:紫、両方:緑）
    for (const kf of kfs) {
        const x      = 8 + (kf.frame / (total - 1)) * (W - 16);
        const isAt   = (kf.frame === cur);
        const hasPose = kf.pose !== undefined;
        const hasCam  = kf.camera !== undefined;
        const color = (hasPose && hasCam) ? "#44ee88"
                    : hasCam              ? "#cc66ff"
                    :                       "#ffdd44";
        ctx.save();
        ctx.translate(Math.round(x), trackY);
        ctx.rotate(Math.PI / 4);
        const half = isAt ? 6 : 5;
        ctx.fillStyle = color;
        if (isAt) {
            ctx.shadowColor = color;
            ctx.shadowBlur  = 6;
        }
        ctx.fillRect(-half, -half, half * 2, half * 2);
        ctx.restore();
    }

    // プレイヘッド
    const px = 8 + (cur / (total - 1)) * (W - 16);
    ctx.strokeStyle = "rgba(255,80,80,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 2); ctx.lineTo(px, H - 2); ctx.stroke();

    // プレイヘッド上三角
    ctx.fillStyle = "rgba(255,80,80,0.9)";
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px, 5);
    ctx.fill();

    // フレーム番号
    ctx.fillStyle = "#888";
    ctx.font = "9px sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText(String(cur), 10, H - 1);
    ctx.textAlign = "right";
    ctx.fillText(String(total - 1), W - 10, H - 1);
}

// タイムラインキャンバスのドラッグ操作
function setupTimelineInteraction(canvas, node) {
    let dragging = false;
    let movingKfFrame = null; // キー移動モード: 現在ドラッグ中の KF のフレーム番号

    function frameFromClientX(clientX) {
        const rect  = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 8) / (rect.width - 16)));
        const total = Math.max(2, node._kfTotalFrames || 60);
        return Math.round(ratio * (total - 1));
    }

    // クリック位置から 12px 以内で最も近い KF を返す
    function nearestKf(clientX) {
        const rect  = canvas.getBoundingClientRect();
        const clickX = clientX - rect.left;
        const W     = rect.width;
        const total = Math.max(2, node._kfTotalFrames || 60);
        let best = null, bestDist = 12;
        for (const kf of (node._keyframes || [])) {
            const kfX = 8 + (kf.frame / (total - 1)) * (W - 16);
            const dist = Math.abs(clickX - kfX);
            if (dist < bestDist) { bestDist = dist; best = kf; }
        }
        return best;
    }

    canvas.addEventListener("mousedown", e => {
        dragging = true;
        if (node._kfMoveKeyMode) {
            const kf = nearestKf(e.clientX);
            if (kf) {
                movingKfFrame = kf.frame;
                seekToFrame(node, kf.frame);
            } else {
                movingKfFrame = null;
            }
        } else {
            seekToFrame(node, frameFromClientX(e.clientX));
        }
    });

    window.addEventListener("mousemove", e => {
        if (!dragging) return;
        if (node._kfMoveKeyMode && movingKfFrame !== null) {
            const newFrame = frameFromClientX(e.clientX);
            if (newFrame !== movingKfFrame) {
                moveKeyframe(node, movingKfFrame, newFrame);
                movingKfFrame = newFrame;
                seekToFrame(node, newFrame, { silent: true });
            }
        } else if (!node._kfMoveKeyMode) {
            seekToFrame(node, frameFromClientX(e.clientX));
        }
    });

    window.addEventListener("mouseup", () => {
        if (node._kfMoveKeyMode && movingKfFrame !== null) {
            seekToFrame(node, movingKfFrame);
        }
        dragging = false;
        movingKfFrame = null;
    });

    // カーソル変更: キー移動モード時はダイヤモンド付近で grab
    canvas.addEventListener("mousemove", e => {
        if (!node._kfMoveKeyMode) { canvas.style.cursor = "pointer"; return; }
        canvas.style.cursor = (dragging || nearestKf(e.clientX)) ? "grab" : "default";
    });
    canvas.addEventListener("mouseleave", () => { canvas.style.cursor = "pointer"; });
}

// 再生開始
function startPlayback(node) {
    if (node._kfPlaying) return;
    node._kfPlaying = true;
    if (node._kfPlayBtn) {
        node._kfPlayBtn.textContent = "⏸";
        node._kfPlayBtn.style.background = "#4a2a1a";
    }

    const fps      = Math.max(1, node._kfFps || 24);
    const interval = 1000 / fps;
    let   lastTime = performance.now();

    function tick() {
        if (!node._kfPlaying) return;
        const now = performance.now();
        if (now - lastTime >= interval) {
            lastTime += interval;
            const total = Math.max(2, node._kfTotalFrames || 60);
            seekToFrame(node, (node._kfCurrentFrame + 1) % total);
        }
        node._kfPlayRaf = requestAnimationFrame(tick);
    }
    node._kfPlayRaf = requestAnimationFrame(tick);
}

// 再生停止
function stopPlayback(node) {
    node._kfPlaying = false;
    if (node._kfPlayRaf) { cancelAnimationFrame(node._kfPlayRaf); node._kfPlayRaf = null; }
    if (node._kfPlayBtn) {
        node._kfPlayBtn.textContent = t("kfPlayBtn");
        node._kfPlayBtn.style.background = "#1a2a4a";
    }
}

// アニメーションを WebM 動画としてエクスポート
// onProgress(currentFrame, totalFrames) でプログレスコールバック
async function exportVideoWebM(node, onProgress) {
    const fps   = Math.max(1, node._kfFps || 24);
    const total = Math.max(2, node._kfTotalFrames || 60);
    const fr    = computeOutputFrame(node);
    if (!fr) return null;
    const { outW, outH } = fr;

    const offCanvas    = document.createElement("canvas");
    offCanvas.width    = outW;
    offCanvas.height   = outH;

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";

    const stream   = offCanvas.captureStream(0);
    const track    = stream.getVideoTracks()[0];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks   = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    const savedFrame = node._kfCurrentFrame;
    recorder.start();

    for (let f = 0; f < total; f++) {
        seekToFrame(node, f, { silent: true });
        renderToOutputCanvas(node, offCanvas);
        track.requestFrame();
        onProgress?.(f + 1, total);
        // レコーダーにフレームを渡す時間を確保
        await new Promise(r => setTimeout(r, 0));
    }

    recorder.stop();
    await new Promise(r => { recorder.onstop = r; });

    // 再生位置を元に戻す
    seekToFrame(node, savedFrame);

    return new Blob(chunks, { type: "video/webm" });
}

// キーフレームアニメーションをライブラリのポーズとしてプロジェクト保存
async function saveKeyframeProject(node) {
    const kfs = node._keyframes || [];
    if (!kfs.length) { alert(t("kfNoKeyframes")); return false; }

    const now = new Date();
    const p2  = n => String(n).padStart(2, "0");
    const ts  = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
    const defaultName = `project-${ts}`;

    const name = prompt(t("kfProjNamePrompt"), defaultName);
    if (!name || !name.trim()) return false;

    const content = {
        _type:           "kf_project",
        keyframes:       JSON.parse(JSON.stringify(kfs)),
        kf_total_frames: node._kfTotalFrames || 60,
        kf_fps:          node._kfFps || 24,
        thumbnail:       null,
    };

    // フレーム0でサムネイルを撮影して元に戻す
    if (node._nodeCanvas && node._psdW) {
        const savedFrame = node._kfCurrentFrame;
        seekToFrame(node, 0, { silent: true });
        content.thumbnail = captureThumbFromNode(node, 140);
        seekToFrame(node, savedFrame, { silent: true });
        drawNodeCanvas(node);
    }

    try {
        const res = await fetch("/psd_loader/library/poses", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ filename: name.trim(), content }),
        });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        return true;
    } catch (e) {
        alert(t("poseSaveFailed", e.message));
        return false;
    }
}

// ================================================
// レイヤー状態管理
// ================================================
class LayerState {
    constructor(layers) {
        this.visibility = {};
        this.renamed = {};
        this.customGroups = [];
        this.rigging = {};  // { layerId: { r:{x,y}, mr:{x,y}, mr_radius:0 } }
        this.pose    = {};  // { layerId: { angle:0, tx:0, ty:0 } }
        this.swLayers = [];  // [{ id, name, points:[{ id, name, x, y, radius, angle, groups:[] }] }]
        this.cgOrder = [...layers].reverse().map(n => n.id);
        this.layerParent = {};  // { childId: parentId } レイヤー間の親子関係
        this.parentTabOrder = { roots: null, children: {} };  // ペアレントタブ表示順（cgOrderとは独立）
        this._walk(layers);
    }

    _walk(nodes) {
        for (const n of nodes) {
            this.visibility[n.id] = n.visible;
            if (n.children) this._walk(n.children);
        }
    }

    toConfig() {
        return {
            visibility: { ...this.visibility },
            renamed:    { ...this.renamed },
            custom_groups: this.customGroups.map(g => ({
                id: g.id, name: g.name, visible: g.visible, layer_ids: [...g.layer_ids],
            })),
            cg_order: [...this.cgOrder],
            layer_parent: { ...this.layerParent },
            parent_tab_order: {
                roots: this.parentTabOrder.roots ? [...this.parentTabOrder.roots] : null,
                children: JSON.parse(JSON.stringify(this.parentTabOrder.children)),
            },
            rigging:   JSON.parse(JSON.stringify(this.rigging)),
            pose:      JSON.parse(JSON.stringify(this.pose)),
            sw_layers: JSON.parse(JSON.stringify(this.swLayers)),
        };
    }

    static fromConfig(layers, config) {
        const s = new LayerState(layers);
        if (config?.visibility)    Object.assign(s.visibility, config.visibility);
        if (config?.renamed)       Object.assign(s.renamed, config.renamed);
        if (config?.custom_groups) {
            s.customGroups = config.custom_groups.map(g => ({
                id:        g.id || `cg_${Math.random().toString(36).slice(2)}`,
                name:      g.name,
                visible:   g.visible !== false,
                layer_ids: [...(g.layer_ids || [])],
            }));
        }
        if (config?.cg_order) {
            s.cgOrder = [...config.cg_order];
        } else if (s.customGroups.length > 0) {
            // 旧形式：ルートCGを先頭、PSDレイヤーを後ろに
            const childCgIds = new Set();
            for (const cg of s.customGroups) {
                for (const lid of cg.layer_ids) if (lid.startsWith('cg_')) childCgIds.add(lid);
            }
            const rootCgIds = s.customGroups.filter(cg => !childCgIds.has(cg.id)).map(cg => cg.id);
            s.cgOrder = [...rootCgIds, ...[...layers].reverse().map(n => n.id)];
        }
        if (config?.layer_parent) Object.assign(s.layerParent, config.layer_parent);
        if (config?.parent_tab_order) {
            s.parentTabOrder.roots    = config.parent_tab_order.roots    ? [...config.parent_tab_order.roots]    : null;
            s.parentTabOrder.children = JSON.parse(JSON.stringify(config.parent_tab_order.children || {}));
        }
        if (config?.rigging) Object.assign(s.rigging, JSON.parse(JSON.stringify(config.rigging)));
        if (config?.pose)    Object.assign(s.pose,    JSON.parse(JSON.stringify(config.pose)));
        if (config?.sw_layers) {
            s.swLayers = JSON.parse(JSON.stringify(config.sw_layers));
        } else if (config?.sw && Object.keys(config.sw).length > 0) {
            // 旧形式 sw:{layerId:{...}} → swLayers への変換（後方互換）
            const swl = { id: `swl_${Math.random().toString(36).slice(2)}`, name: "SW1", points: [] };
            for (const [, swInfo] of Object.entries(config.sw)) {
                swl.points.push({
                    id: `swp_${Math.random().toString(36).slice(2)}`,
                    name: swInfo.name ?? "sw1",
                    x: swInfo.x ?? 0,
                    y: swInfo.y ?? 0,
                    radius: swInfo.radius ?? 80,
                    angle: swInfo.angle ?? 0,
                    groups: [...(swInfo.groups ?? [])],
                });
            }
            s.swLayers = [swl];
        }
        return s;
    }
}

// ================================================
// モーダル
// ================================================
class PSDModal {
    constructor(node, layerTree, existingConfig) {
        ensureCSS();
        this.node          = node;
        this.layerTree     = JSON.parse(JSON.stringify(layerTree));
        this.state         = LayerState.fromConfig(this.layerTree, existingConfig);
        this.selectedIds   = new Set();
        this.collapsedIds  = new Set();
        this._selectedCgId = null;
        this._dragSrcId    = null;
        this._dragSrcCgId  = null;
        this._activeTab    = 'layer';

        // リグ関連
        this._rigMode        = 'normal'; // 'normal' | 'setup' | 'pose'
        this._setupPointType = 'r';  // 'r' | 'mr'
        this._rigDrag        = null;     // ドラッグ中: { layerId, type, startWx, startWy, startVal }
        this._rigDragging    = false;
        this._showRigLabels     = true;  // ポーズモードでのラベル表示フラグ
        this._rigPointSize      = 1.0;   // リグポイントサイズ倍率
        this._previewCam        = { x: 0, y: 0, zoom: 1 }; // モーダルプレビューカメラ
        this._defaultPreviewCam = { x: 0, y: 0, zoom: 1 };

        this._overlay = this._buildDOM();
        document.body.appendChild(this._overlay);
        this._renderTree();
        this._initPreview();
    }

    _buildDOM() {
        const overlay = document.createElement("div");
        overlay.className = "psd-overlay";
        overlay.addEventListener("mousedown", e => { if (e.target === overlay) this.destroy(); });

        const modal = document.createElement("div");
        modal.className = "psd-modal";

        const header = document.createElement("div");
        header.className = "psd-modal-header";
        const title = document.createElement("span");
        title.textContent = t("modalTitle");

        // ---- リグモードボタン ----
        const rigModeWrap = document.createElement("div");
        rigModeWrap.style.cssText = "display:flex;gap:4px;align-items:center;margin:0 8px;";

        const mkRigBtn = (label, mode, color) => {
            const b = document.createElement("button");
            b.className = "psd-btn";
            b.textContent = label;
            b.title = label;
            b.style.cssText = `padding:2px 8px;font-size:11px;background:${color};border-color:${color};`;
            b.onclick = () => {
                this._rigMode = (this._rigMode === mode) ? 'normal' : mode;
                this._updateRigModeUI(setupBar);
            };
            return b;
        };
        this._btnSetup = mkRigBtn("Setup", 'setup', "#2a4a6a");
        this._btnPose  = mkRigBtn("Pose",  'pose',  "#2a5a3a");
        rigModeWrap.append(this._btnSetup, this._btnPose);

        // ---- セットアップ専用バー ----
        const setupBar = document.createElement("div");
        setupBar.style.cssText = "display:none;gap:4px;align-items:center;padding:4px 8px;background:#1a2a3a;border-bottom:1px solid #313244;flex-wrap:wrap;";

        const mkSetupBtn = (label, type, color) => {
            const b = document.createElement("button");
            b.className = "psd-btn";
            b.textContent = label;
            b.style.cssText = `padding:2px 8px;font-size:11px;background:${color};border-color:${color};`;
            b.onclick = () => { this._setupPointType = type; this._updateSetupBtns(); this._drawPreview(); };
            b.dataset.pointType = type;
            return b;
        };
        this._btnR  = mkSetupBtn("R",  'r',  "#1a3a6a");
        this._btnMR = mkSetupBtn("MR", 'mr', "#3a1a1a");
        this._btnSW = mkSetupBtn("SW", 'sw', "#1a3a1a");
        const delRigBtn = document.createElement("button");
        delRigBtn.className = "psd-btn";
        delRigBtn.textContent = t("deleteRigBtn");
        delRigBtn.style.cssText = "padding:2px 8px;font-size:11px;";
        delRigBtn.title = t("deleteRigTooltip");
        delRigBtn.onclick = () => this._deleteSelectedRig();

        const setupHint = document.createElement("span");
        setupHint.style.cssText = "font-size:10px;color:#888;";
        setupHint.textContent = t("setupHint");

        setupBar.append(this._btnR, this._btnMR, this._btnSW, delRigBtn, setupHint);
        this._setupBar = setupBar;

        // ---- ポーズ専用バー ----
        const poseBar = document.createElement("div");
        poseBar.style.cssText = "display:none;gap:4px;align-items:center;padding:4px 8px;background:#1a3a2a;border-bottom:1px solid #313244;";

        const lblBtn = document.createElement("button");
        lblBtn.className = "psd-btn";
        lblBtn.textContent = t("labelBtn");
        lblBtn.style.cssText = "padding:2px 8px;font-size:11px;";
        lblBtn.title = t("labelBtnTooltip");
        lblBtn.onclick = () => {
            this._showRigLabels = !this._showRigLabels;
            this._updatePoseBarUI();
            this._drawPreview();
        };
        this._lblBtn = lblBtn;
        poseBar.appendChild(lblBtn);
        this._poseBar = poseBar;

        const closeBtn = document.createElement("button");
        closeBtn.className = "psd-close-btn";
        closeBtn.textContent = "✕";
        closeBtn.onclick = () => this.destroy();
        header.append(title, rigModeWrap, closeBtn);

        const body = document.createElement("div");
        body.className = "psd-modal-body";

        const previewPanel = document.createElement("div");
        previewPanel.className = "psd-preview-panel";

        const previewLabel = document.createElement("div");
        previewLabel.className = "psd-preview-label";
        previewLabel.textContent = t("previewLabel");

        this._previewCanvas = document.createElement("canvas");
        this._previewCanvas.className = "psd-preview-canvas";

        this._previewStatusEl = document.createElement("div");
        this._previewStatusEl.className = "psd-preview-status";

        const modalRpBtn = document.createElement("button");
        modalRpBtn.className = "psd-btn";
        modalRpBtn.textContent = "RP";
        modalRpBtn.title = t("resetPoseTooltip");
        modalRpBtn.style.cssText = "padding:3px 0;font-size:11px;width:100%;margin-top:4px;";
        modalRpBtn.onclick = () => {
            for (const id of Object.keys(this.state.rigging)) {
                this.state.pose[id] = { angle: 0, tx: 0, ty: 0 };
            }
            this._drawPreview();
        };
        this._modalRpBtn = modalRpBtn;

        // ---- ポイントサイズスライダー（モーダル）----
        const modalSliderWrap = document.createElement("div");
        modalSliderWrap.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 0 2px;";
        const modalSliderLabel = document.createElement("span");
        modalSliderLabel.textContent = "Point Size";
        modalSliderLabel.style.cssText = "font-size:11px;color:#cdd6f4;white-space:nowrap;flex-shrink:0;";
        const modalSlider = document.createElement("input");
        modalSlider.type = "range";
        modalSlider.min = "0.5";
        modalSlider.max = "3.0";
        modalSlider.step = "0.1";
        modalSlider.value = "1.0";
        modalSlider.style.cssText = "flex:1;accent-color:#4499ff;cursor:pointer;";
        const modalSliderVal = document.createElement("span");
        modalSliderVal.textContent = "1.0";
        modalSliderVal.style.cssText = "font-size:11px;color:#cdd6f4;width:28px;text-align:right;flex-shrink:0;";
        modalSlider.addEventListener("input", () => {
            this._rigPointSize = parseFloat(modalSlider.value);
            modalSliderVal.textContent = parseFloat(modalSlider.value).toFixed(1);
            this._drawPreview();
        });
        modalSliderWrap.append(modalSliderLabel, modalSlider, modalSliderVal);

        previewPanel.append(previewLabel, this._previewCanvas, this._previewStatusEl, modalSliderWrap, modalRpBtn);

        const rightPanel = document.createElement("div");
        rightPanel.className = "psd-right-panel";

        // タブバー
        const tabBar = document.createElement("div");
        tabBar.style.cssText = "display:flex;border-bottom:1px solid #313244;flex-shrink:0;";
        const mkTabBtn = label => {
            const b = document.createElement("button");
            b.className = "psd-btn";
            b.textContent = label;
            b.style.cssText = "flex:1;border-radius:0;border:none;font-size:12px;padding:5px 8px;outline-offset:-2px;";
            return b;
        };
        const tabLayerBtn  = mkTabBtn(t("tabLayer"));
        const tabParentBtn = mkTabBtn(t("tabParent"));
        const tabSwitchBtn = mkTabBtn(t("tabSwitch"));
        tabBar.append(tabLayerBtn, tabParentBtn, tabSwitchBtn);

        // レイヤータブ
        const layerTabContent = document.createElement("div");
        layerTabContent.style.cssText = "display:flex;flex-direction:column;flex:1;overflow:hidden;";
        this._layerListEl = document.createElement("div");
        this._layerListEl.className = "psd-layer-list";
        const layerGroupBar = document.createElement("div");
        layerGroupBar.className = "psd-group-bar";
        layerGroupBar.append(
            this._mkBtn(t("createGroup"),   () => this._createGroup()),
            this._mkBtn(t("ungroup"),        () => this._ungroup()),
            this._mkBtn(t("addSwLayer"),     () => this._createSwLayer()),
            this._mkBtn(t("deleteSwLayer"),  () => this._deleteSwLayer()),
        );
        layerTabContent.append(this._layerListEl, layerGroupBar);

        // ペアレントタブ
        const parentTabContent = document.createElement("div");
        parentTabContent.style.cssText = "display:none;flex-direction:column;flex:1;overflow:hidden;";
        this._parentListEl = document.createElement("div");
        this._parentListEl.className = "psd-layer-list";
        const parentGroupBar = document.createElement("div");
        parentGroupBar.className = "psd-group-bar";
        parentGroupBar.append(
            this._mkBtn("▲", () => this._shiftParentTabItem(-1)),
            this._mkBtn("▼", () => this._shiftParentTabItem(1)),
            this._mkBtn("◀", () => this._outdent()),
            this._mkBtn("▶", () => this._indent()),
        );
        parentTabContent.append(this._parentListEl, parentGroupBar);

        // スイッチタブ
        const switchTabContent = document.createElement("div");
        switchTabContent.style.cssText = "display:none;flex-direction:column;flex:1;overflow:hidden;";
        this._switchListEl = document.createElement("div");
        this._switchListEl.className = "psd-layer-list";
        this._switchGroupEl = document.createElement("div");
        this._switchGroupEl.style.cssText = "flex:1;overflow-y:auto;padding:4px 8px;font-size:11px;min-height:0;";
        const switchBar = document.createElement("div");
        switchBar.className = "psd-group-bar";
        const makeAddSwBtn = (text, tipKey, mode) => {
            const btn = document.createElement("button");
            btn.className = "psd-btn";
            btn.textContent = text;
            btn.title = t(tipKey);
            btn.onclick = () => this._addSwGroup(mode);
            return btn;
        };
        const delSwGroupBtn = document.createElement("button");
        delSwGroupBtn.className = "psd-btn";
        delSwGroupBtn.textContent = "−";
        delSwGroupBtn.title = t("deleteGroupTooltip");
        delSwGroupBtn.onclick = () => this._removeSwGroup();
        switchBar.append(
            makeAddSwBtn("+L", "addLayerEntryTooltip",     "layer"),
            makeAddSwBtn("+P", "addPieceEntryTooltip",     "piece"),
            makeAddSwBtn("+C", "addCompositeEntryTooltip", "composite"),
            delSwGroupBtn
        );
        switchTabContent.append(this._switchListEl, this._switchGroupEl, switchBar);
        this._selectedSwLayerId  = null;
        this._selectedSwPointInfo = null;
        this._selectedSwGroupIdx = -1;

        // タブ切り替え
        const updateTabStyle = () => {
            [
                { btn: tabLayerBtn,  key: 'layer'  },
                { btn: tabParentBtn, key: 'parent' },
                { btn: tabSwitchBtn, key: 'switch' },
            ].forEach(({ btn, key }) => {
                const active = this._activeTab === key;
                btn.style.background = active ? "#313244" : "";
                btn.style.outline    = active ? "2px solid #f38ba8" : "none";
            });
            layerTabContent.style.display  = this._activeTab === 'layer'  ? "flex" : "none";
            parentTabContent.style.display = this._activeTab === 'parent' ? "flex" : "none";
            switchTabContent.style.display = this._activeTab === 'switch' ? "flex" : "none";
        };
        tabLayerBtn.onclick  = () => { this._activeTab = 'layer';  updateTabStyle(); };
        tabParentBtn.onclick = () => { this._activeTab = 'parent'; updateTabStyle(); this._renderTree(); };
        tabSwitchBtn.onclick = () => { this._activeTab = 'switch'; updateTabStyle(); this._renderSwitchTab(); };
        updateTabStyle();

        rightPanel.append(tabBar, layerTabContent, parentTabContent, switchTabContent);
        body.append(previewPanel, rightPanel);

        const footer = document.createElement("div");
        footer.className = "psd-modal-footer";
        const poseSaveBtn = this._mkBtn(t("poseBtn"), () => this._savePoseFromModal());
        poseSaveBtn.title = t("poseSaveTooltip");
        poseSaveBtn.addEventListener("contextmenu", e => { e.preventDefault(); this._savePoseWithSwFromModal(); });
        const helpBtn = this._mkBtn(t("helpBtn"), () => this._showHelp());
        helpBtn.style.cssText = "margin-right:auto;min-width:28px;padding:5px 10px;font-weight:bold;";
        helpBtn.title = t("helpTitle");
        footer.append(
            helpBtn,
            this._mkBtn(t("cancelBtn"), () => this.destroy()),
            this._mkBtn(t("saveBtn"),   () => this._saveConfig()),
            poseSaveBtn,
            this._mkBtn(t("applyBtn"),  () => this._apply(), true),
        );

        // ---- ファイル操作バー（常時表示） ----
        const fileBar = document.createElement("div");
        fileBar.style.cssText = "display:flex;gap:4px;align-items:center;padding:4px 8px;border-bottom:1px solid #313244;flex-shrink:0;";

        const modalNewBtn = document.createElement("button");
        modalNewBtn.className = "psd-btn";
        modalNewBtn.textContent = t("newBtn");
        modalNewBtn.title = t("newBtnTooltip");
        modalNewBtn.style.cssText = "padding:3px 8px;font-size:11px;flex:1;min-width:0;white-space:nowrap;";
        modalNewBtn.onclick = async () => {
            if (!confirm(t("confirmNewRig"))) return;
            const lw = findWidget(this.node, "layer_config");
            if (lw) lw.value = "{}";
            this._rigMode = 'normal';
            this._updateRigModeUI(this._setupBar);
            await this._reloadFromNode();
        };

        const modalPsdBtn = document.createElement("button");
        modalPsdBtn.className = "psd-btn";
        {
            const fn = this.node._psdFilename || findWidget(this.node, "psd_filename")?.value || "";
            modalPsdBtn.textContent = fn ? `📂 ${fn}` : "📂 psd";
        }
        modalPsdBtn.title = t("selectPsdTooltip");
        modalPsdBtn.style.cssText = "padding:3px 8px;font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;";
        modalPsdBtn.onclick = () => {
            const input = getFileInput();
            input.onchange = null;
            input.onchange = async e => {
                const f = e.target.files[0];
                if (f) {
                    await uploadPSD(f, this.node);
                    const fn = this.node._psdFilename || "";
                    modalPsdBtn.textContent = fn ? `📂 ${fn}` : "📂 psd";
                    await this._reloadFromNode();
                }
                input.value = "";
            };
            input.click();
        };

        const modalPsdModelBtn = document.createElement("button");
        modalPsdModelBtn.className = "psd-btn";
        modalPsdModelBtn.textContent = t("modelBtn");
        modalPsdModelBtn.title = t("loadModelTooltip");
        modalPsdModelBtn.style.cssText = "padding:3px 8px;font-size:11px;flex-shrink:0;";
        modalPsdModelBtn.onclick = () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = ".json,.psd-model.json";
            inp.onchange = async e => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const data = JSON.parse(await file.text());
                    if (data.layer_config) {
                        const lw = findWidget(this.node, "layer_config");
                        if (lw) lw.value = JSON.stringify(data.layer_config);
                    }
                    if (data.psd_filename) {
                        const fname = data.psd_filename;
                        const fw = findWidget(this.node, "psd_filename");
                        if (fw) fw.value = fname;
                        this.node._psdFilename = fname;
                        modalPsdBtn.textContent = `📂 ${fname}`;
                        try {
                            const res = await fetch(`/psd_loader/layers?filename=${encodeURIComponent(fname)}`);
                            const ld  = await res.json();
                            if (!ld.error) {
                                this.node._psdLayers = ld.layers;
                                this.node._psdW = ld.width;
                                this.node._psdH = ld.height;
                                this.node._layerImages = null;
                                setDefaultCamera(this.node);
                            }
                        } catch (_) {}
                    }
                    await this._reloadFromNode();
                    await refreshNodePreview(this.node);
                } catch (err) { alert(t("modelFileLoadFailed", err.message)); }
                inp.value = "";
            };
            inp.click();
        };

        const modalRefreshBtn = document.createElement("button");
        modalRefreshBtn.className = "psd-btn";
        modalRefreshBtn.textContent = "⟳";
        modalRefreshBtn.title = t("refreshTooltip");
        modalRefreshBtn.style.cssText = "padding:3px 6px;font-size:11px;flex-shrink:0;";
        modalRefreshBtn.onclick = () => { this.node._layerImages = null; refreshNodePreview(this.node); };

        fileBar.append(modalNewBtn, modalPsdBtn, modalPsdModelBtn, modalRefreshBtn);

        modal.append(header, fileBar, setupBar, poseBar, body, footer);
        overlay.appendChild(modal);
        return overlay;
    }

    _showHelp() {
        const lang = getLang();
        const isJa = lang === 'ja';
        const isZh = lang === 'zh';

        const sections = isJa ? [
            {
                title: "基本操作",
                rows: [
                    ["PSD 読み込み", "ファイルバーの 📂 psd ボタン、またはキャンバスへのドラッグ&ドロップ"],
                    ["モデル読み込み", "📂 model ボタンで .psd-model.json ファイルを読み込む"],
                    ["設定を保存", "💾 保存 ボタンでモデルファイルに書き出し"],
                    ["適用", "適用 ボタンで layer_config ウィジェットに書き込み、Queue Prompt で出力"],
                    ["プレビュー更新", "⟳ ボタン、またはウィンドウを開き直す"],
                ],
            },
            {
                title: "レイヤータブ",
                rows: [
                    ["表示切替", "レイヤー行の 👁 アイコンをクリック"],
                    ["名前変更", "レイヤー名をダブルクリックして編集"],
                    ["順序変更", "レイヤー行をドラッグ&ドロップ"],
                    ["カスタムグループ作成", "レイヤーを複数選択して「グループ作成」ボタン — スイッチタブでレイヤー単位に展開可能"],
                    ["グループ解除", "カスタムグループを選択して「グループ解除」ボタン"],
                    ["SWレイヤー追加/削除", "「SW追加」「SW削除」ボタン（スイッチタブで設定）"],
                ],
            },
            {
                title: "ペアレントタブ",
                rows: [
                    ["ペアレント設定", "リスト上でアイテムを選択し ▲▼ で順序変更、▶ でインデント（子に）、◀ でアウトデント（親から独立）"],
                    ["目的", "子レイヤーは親レイヤーのトランスフォームを継承してポーズが合成される"],
                    ["⚠ クリッピングレイヤー", "クリッピングレイヤー（✂）とそのベースレイヤーが一緒に動くには、両レイヤーに同じ親を設定してください。ベースレイヤーにのみ親を設定した場合、クリッピングレイヤーは追従しません"],
                ],
            },
            {
                title: "スイッチタブ",
                rows: [
                    ["SWレイヤー選択", "左列でSWレイヤーを選択すると右列にSWポイントが表示される"],
                    ["SWポイント追加", "Setupモードで SW ボタンを選択してキャンバスをクリック"],
                    ["エントリ追加", "+L: 個別レイヤーを1スロットとして追加 / +P: グループ/フォルダをメンバーごとに展開して追加（Piece） / +C: グループ/フォルダ全体を合成して1スロットとして追加（Composite）"],
                    ["エントリ削除", "エントリを選択して − ボタンで削除"],
                    ["バッジ", "[L] 個別レイヤー（1スロット） / [P] Pieceグループ（メンバー数スロット） / [C] Compositeグループ（常に1スロット）"],
                    ["スロット展開", "[P]はメンバーレイヤー数分のスロットに展開。例: 3レイヤーグループ = 3スロット（0°・30°・60°）。[C]は常に1スロット"],
                    ["角度表示", "1スロット: 「30°」、複数スロット: 「0°-60°」のように範囲表示"],
                    ["最大スロット数", "全エントリの合計スロット数が12まで"],
                    ["⚠ 孤立エントリ", "グループ/フォルダが解除・削除されると赤背景と ⚠ で表示 → 該当エントリを削除してください"],
                    ["動作", "SWポイントのハンドル角度でアクティブスロットが切り替わる（1スロット = 30°）"],
                ],
            },
            {
                title: "Setup モード",
                rows: [
                    ["有効化", "ヘッダーの Setup ボタンをクリック（もう一度クリックで通常モードに戻る）"],
                    ["R ポイント（青）", "回転軸。選択レイヤー上でクリックして配置。Pose モードでは回転ドラッグで角度を変える"],
                    ["MR ポイント（赤）", "平行移動軸（可動範囲円あり）。Pose モードで orange ハンドルをドラッグして移動"],
                    ["SW ポイント（緑）", "スイッチポイント。ハンドル（水色）を回転させてアクティブスロットを切り替える"],
                    ["ポイント削除", "対象レイヤーを選択して「🗑 削除」ボタン"],
                ],
            },
            {
                title: "Pose モード",
                rows: [
                    ["有効化", "ヘッダーの Pose ボタンをクリック"],
                    ["回転 (R)", "青いリグポイントをドラッグして回転"],
                    ["移動 (MR)", "orange ハンドルをドラッグして平行移動（可動範囲円内で制限）"],
                    ["スイッチ切替", "水色の SW ハンドルを回転"],
                    ["ラベル表示", "🏷 ラベル ボタンでポイント上のレイヤー名を表示/非表示"],
                    ["ポーズ保存", "📷 ポーズ ボタン（右クリック: SW状態込みで保存）。サムネイルはラベル非表示で自動作成"],
                    ["ポーズリセット", "RP ボタンで全ポーズをリセット"],
                ],
            },
            {
                title: "カメラ操作（モーダルプレビュー）",
                rows: [
                    ["ズーム", "マウスホイール"],
                    ["パン", "ドラッグ（何もない場所）"],
                    ["リセット", "RC ボタン"],
                ],
            },
            {
                title: "カメラ操作（ノードプレビュー）",
                rows: [
                    ["ズーム", "マウスホイール"],
                    ["パン", "左ドラッグ"],
                    ["ロール", "Alt＋右ドラッグ"],
                    ["カメラリセット", "ノード上の RC ボタン"],
                ],
            },
        ] : isZh ? [
            {
                title: "基本操作",
                rows: [
                    ["加载PSD", "点击文件栏的 📂 psd 按钮，或拖放到画布"],
                    ["加载模型", "点击 📂 model 按钮加载 .psd-model.json 文件"],
                    ["保存设置", "点击 💾 保存 按钮导出模型文件"],
                    ["应用", "点击 应用 按钮写入 layer_config，通过 Queue Prompt 输出"],
                    ["刷新预览", "点击 ⟳ 按钮或重新打开窗口"],
                ],
            },
            {
                title: "图层选项卡",
                rows: [
                    ["切换可见性", "点击图层行的 👁 图标"],
                    ["重命名", "双击图层名称进行编辑"],
                    ["调整顺序", "拖放图层行"],
                    ["创建自定义组", "多选图层后点击「创建组」按钮 — 可在切换选项卡中按图层展开"],
                    ["解除组", "选中自定义组后点击「解除组」按钮"],
                    ["SW图层", "使用「添加SW」/「删除SW」按钮（在切换选项卡中配置）"],
                ],
            },
            {
                title: "父级选项卡",
                rows: [
                    ["父级设置", "在列表中选择项目，用 ▲▼ 调整顺序，▶ 缩进（设为子级），◀ 取消缩进（独立）"],
                    ["效果", "子图层继承父图层的变换，用于姿势合成"],
                    ["⚠ 剪贴蒙版图层", "剪贴蒙版图层（✂）要随基础图层一起移动，两者需设置相同的父级。若仅基础图层设置了父级，剪贴蒙版图层不会跟随"],
                ],
            },
            {
                title: "切换选项卡",
                rows: [
                    ["选择SW图层", "在左列选择SW图层，右列显示SW点"],
                    ["添加SW点", "在Setup模式下选择SW后点击画布"],
                    ["添加条目", "+L: 将单个图层添加为1个槽位 / +P: 将组/文件夹按图层逐一展开（Piece） / +C: 将组/文件夹整体合成为1个槽位（Composite）"],
                    ["删除条目", "选中条目后点击 − 删除"],
                    ["标记", "[L] 单个图层（1槽位） / [P] Piece组（成员数槽位） / [C] Composite组（始终1槽位）"],
                    ["插槽展开", "[P]按成员图层数展开。例: 3图层的组 = 3个插槽（0°・30°・60°）。[C]始终为1个插槽"],
                    ["最大插槽数", "所有条目的插槽总数最多12个"],
                    ["⚠ 孤立条目", "组/文件夹被解除时显示红色背景和 ⚠ → 请删除该条目"],
                    ["动作", "SW点手柄角度切换当前插槽（1插槽 = 30°）"],
                ],
            },
            {
                title: "Setup 模式",
                rows: [
                    ["启用", "点击标题栏的 Setup 按钮（再次点击退出）"],
                    ["R 点（蓝色）", "旋转轴，点击放置。Pose模式下拖动旋转"],
                    ["MR 点（红色）", "平移轴，Pose模式下拖动橙色手柄移动"],
                    ["SW 点（绿色）", "切换点，旋转水色手柄切换活动插槽"],
                    ["删除点", "选中图层后点击「🗑 删除」按钮"],
                ],
            },
            {
                title: "Pose 模式",
                rows: [
                    ["启用", "点击标题栏的 Pose 按钮"],
                    ["旋转 (R)", "拖动蓝色绑定点"],
                    ["平移 (MR)", "拖动橙色手柄（限于范围圆内）"],
                    ["切换", "旋转水色 SW 手柄"],
                    ["标签显示", "点击 🏷 标签 按钮切换点位标签显示"],
                    ["保存姿势", "点击 📷 姿势 按钮（右键: 含切换状态保存）。缩略图自动隐藏标签后生成"],
                    ["重置姿势", "点击 RP 重置所有姿势"],
                ],
            },
            {
                title: "摄像机操作（编辑器预览）",
                rows: [
                    ["缩放", "鼠标滚轮"],
                    ["平移", "拖动（空白区域）"],
                    ["重置", "RC 按钮"],
                ],
            },
            {
                title: "摄像机操作（节点预览）",
                rows: [
                    ["缩放", "鼠标滚轮"],
                    ["平移", "左键拖动"],
                    ["旋转", "Alt+右键拖动"],
                    ["重置摄像机", "节点上的 RC 按钮"],
                ],
            },
        ] : [
            {
                title: "Basic Operations",
                rows: [
                    ["Load PSD", "Click 📂 psd in the file bar, or drag & drop onto the canvas"],
                    ["Load Model", "Click 📂 model to load a .psd-model.json file"],
                    ["Save", "Click 💾 Save to export a model file"],
                    ["Apply", "Click Apply to write to layer_config, then use Queue Prompt to render"],
                    ["Refresh Preview", "Click ⟳ or reopen the modal"],
                ],
            },
            {
                title: "Layer Tab",
                rows: [
                    ["Toggle Visibility", "Click the 👁 icon on a layer row"],
                    ["Rename", "Double-click the layer name"],
                    ["Reorder", "Drag & drop layer rows"],
                    ["Create Custom Group", "Select multiple layers, then click 'Group' — expandable per-layer in the Switch tab"],
                    ["Ungroup", "Select a custom group, then click 'Ungroup'"],
                    ["SW Layer", "Use 'Add SW' / 'Del SW' buttons (configure in Switch tab)"],
                ],
            },
            {
                title: "Parent Tab",
                rows: [
                    ["Parent Setup", "Select an item, use ▲▼ to reorder, ▶ to indent (make child), ◀ to outdent"],
                    ["Effect", "Child layers inherit the parent's transform for pose compositing"],
                    ["⚠ Clipping Layers", "For a clipping layer (✂) to follow its base layer, both must share the same parent. If only the base layer has a parent set, the clipping layer will not follow it"],
                ],
            },
            {
                title: "Switch Tab",
                rows: [
                    ["Select SW Layer", "Pick a SW layer in the left column to see its SW points"],
                    ["Add SW Point", "In Setup mode, select SW then click the canvas"],
                    ["Add Entry", "+L: add individual layer as 1 slot / +P: add group/folder expanded per-layer (Piece) / +C: add group/folder composited as 1 slot (Composite)"],
                    ["Remove Entry", "Select an entry and click − to remove"],
                    ["Badges", "[L] individual layer (1 slot) / [P] Piece group (N slots) / [C] Composite group (always 1 slot)"],
                    ["Slot Expansion", "[P] expands per member layer. e.g. 3-layer group = 3 slots (0°, 30°, 60°). [C] is always 1 slot"],
                    ["Angle Display", "Single slot: '30°' / Multiple slots: '0°–60°' range notation"],
                    ["Max Slots", "Total slots across all entries: 12"],
                    ["⚠ Orphaned Entry", "Shown in red with ⚠ when the referenced group/folder no longer exists — delete the entry"],
                    ["Behavior", "Handle angle selects the active slot (1 slot = 30°)"],
                ],
            },
            {
                title: "Setup Mode",
                rows: [
                    ["Enable", "Click the Setup button in the header (click again to exit)"],
                    ["R Point (blue)", "Rotation pivot. Click to place. In Pose mode, drag to rotate"],
                    ["MR Point (red)", "Translation axis with movement range. In Pose mode, drag orange handle"],
                    ["SW Point (green)", "Switch point. Rotate the cyan handle to change active slot"],
                    ["Delete Rig", "Select the target layer, then click '🗑 Delete'"],
                ],
            },
            {
                title: "Pose Mode",
                rows: [
                    ["Enable", "Click the Pose button in the header"],
                    ["Rotate (R)", "Drag the blue rig point"],
                    ["Translate (MR)", "Drag the orange handle (constrained to range circle)"],
                    ["Switch", "Rotate the cyan SW handle"],
                    ["Labels", "Toggle layer name labels with 🏷 Labels"],
                    ["Save Pose", "Click 📷 Pose (right-click to include switch states). Thumbnail is captured with labels hidden automatically"],
                    ["Reset Pose", "Click RP to zero all poses"],
                ],
            },
            {
                title: "Camera (Editor Preview)",
                rows: [
                    ["Zoom", "Mouse wheel"],
                    ["Pan", "Drag on empty area"],
                    ["Reset", "RC button"],
                ],
            },
            {
                title: "Camera (Node Preview)",
                rows: [
                    ["Zoom", "Mouse wheel"],
                    ["Pan", "Left-drag"],
                    ["Roll", "Alt + right-drag"],
                    ["Reset", "Click RC button on the node"],
                ],
            },
        ];

        const overlay = document.createElement("div");
        overlay.className = "psd-overlay";
        overlay.style.zIndex = "10001";
        overlay.addEventListener("mousedown", e => { if (e.target === overlay) overlay.remove(); });

        const dialog = document.createElement("div");
        dialog.className = "psd-help-dialog";

        const header = document.createElement("div");
        header.className = "psd-help-header";
        const titleEl = document.createElement("span");
        titleEl.textContent = t("helpTitle");
        const closeBtn = document.createElement("button");
        closeBtn.className = "psd-btn";
        closeBtn.textContent = t("helpClose");
        closeBtn.style.cssText = "padding:3px 12px;font-size:12px;";
        closeBtn.onclick = () => overlay.remove();
        header.append(titleEl, closeBtn);

        const body = document.createElement("div");
        body.className = "psd-help-body";

        for (const sec of sections) {
            const secEl = document.createElement("section");
            secEl.className = "psd-help-section";
            const h = document.createElement("h3");
            h.className = "psd-help-section-title";
            h.textContent = sec.title;
            secEl.appendChild(h);
            const table = document.createElement("table");
            table.className = "psd-help-table";
            for (const [term, desc] of sec.rows) {
                const tr = document.createElement("tr");
                const td1 = document.createElement("td");
                td1.className = "psd-help-term";
                td1.textContent = term;
                const td2 = document.createElement("td");
                td2.className = "psd-help-desc";
                td2.textContent = desc;
                tr.append(td1, td2);
                table.appendChild(tr);
            }
            secEl.appendChild(table);
            body.appendChild(secEl);
        }

        dialog.append(header, body);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }

    _mkBtn(label, onClick, primary = false) {
        const b = document.createElement("button");
        b.className = "psd-btn" + (primary ? " primary" : "");
        b.textContent = label;
        b.onclick = onClick;
        return b;
    }

    async _initPreview() {
        const node = this.node;
        this._previewCanvas.width  = MODAL_CANVAS_W;
        this._previewCanvas.height = MODAL_CANVAS_H;
        if (!node._layerImages) {
            const filename = node._psdFilename || findWidget(node, "psd_filename")?.value;
            if (!filename) { this._previewStatusEl.textContent = t("psdFileNotSelected"); return; }
            this._previewStatusEl.textContent = t("loadingLayerImages");
            try {
                node._layerImages = await loadLayerImages(filename, this.layerTree);
            } catch (e) {
                this._previewStatusEl.textContent = t("loadError", e.message);
                return;
            }
        }
        this._setDefaultPreviewCam();
        this._drawPreview();
        this._setupRigInteraction();
        this._updateSetupBtns();
    }

    _getEffectiveImageMap() {
        const node = this.node;
        const base = node._layerImages || {};
        const psdW = node._psdW || 0;
        const psdH = node._psdH || 0;
        if (!this.state.customGroups.length) return base;
        const map = Object.assign(Object.create(null), base);
        for (const cg of this.state.customGroups) {
            if (!(cg.id in map)) {
                map[cg.id] = { img: null, objUrl: null, isCgLayer: true, left: 0, top: 0, width: psdW, height: psdH };
            }
        }
        return map;
    }

    _setDefaultPreviewCam() {
        const node = this.node;
        if (!node._psdW || !node._psdH) return;
        const W = MODAL_CANVAS_W, H = MODAL_CANVAS_H;
        const zoom = Math.min(W / node._psdW, H / node._psdH) * 0.95;
        const cam = {
            x: (W - node._psdW) / 2,
            y: (H - node._psdH) / 2,
            zoom,
        };
        this._previewCam        = { ...cam };
        this._defaultPreviewCam = { ...cam };
    }

    _drawPreview() {
        const node = this.node;
        if (!node._layerImages || !node._psdW) return;
        const canvas = this._previewCanvas;
        const ctx = canvas.getContext("2d");
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // チェッカー背景
        const gs = 12;
        for (let y = 0; y < H; y += gs) {
            for (let x = 0; x < W; x += gs) {
                ctx.fillStyle = ((Math.floor(x / gs) + Math.floor(y / gs)) % 2 === 0) ? "#2a2a2a" : "#3a3a3a";
                ctx.fillRect(x, y, gs, gs);
            }
        }

        const cam = this._previewCam;
        const config = this.state.toConfig();

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(cam.zoom, cam.zoom);
        ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);

        const imageMap = this._getEffectiveImageMap();
        renderLayersToCtx(ctx, this.layerTree, imageMap, config);

        // PSDキャンバス境界線（ctx変換内で描画）
        if (node._psdW && node._psdH) {
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,100,0.5)";
            ctx.lineWidth   = 1 / cam.zoom;
            ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
            ctx.strokeRect(0, 0, node._psdW, node._psdH);
            ctx.restore();
        }

        // リグオーバーレイ（カメラ変換内で描画）
        if (this._rigMode !== 'normal' && (config.rigging || config.sw_layers?.length)) {
            const selId      = this._getSelectedLayerId();
            const showLabels = this._rigMode === 'setup' || (this._rigMode === 'pose' && this._showRigLabels);
            drawRigOverlay(
                ctx, this.layerTree, imageMap,
                config.rigging || {}, config.pose,
                this._rigMode, selId, this._setupPointType,
                showLabels, config.renamed || {}, config.layer_parent || {},
                this.state.customGroups, this._rigPointSize ?? 1.0,
                config.sw_layers || [], this._selectedSwPointInfo ?? null
            );
        }

        ctx.restore();

        // --- 出力フレームオーバーレイ（半透明緑線、常時表示） ---
        const mof = this._computeModalOutputFrame();
        if (mof) {
            ctx.save();
            ctx.strokeStyle = "rgba(0,220,80,0.65)";
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.strokeRect(Math.round(mof.sx) + 0.5, Math.round(mof.sy) + 0.5, Math.round(mof.sw) - 1, Math.round(mof.sh) - 1);
            ctx.restore();
        }

        this._previewStatusEl.textContent = "";
    }

    _computeModalOutputFrame() {
        const node = this.node;
        if (!node._psdW || !node._psdH || !this._previewCam) return null;
        const psdW = node._psdW, psdH = node._psdH;
        const outW = parseInt(findWidget(node, "output_width")?.value)  || 512;
        const outH = parseInt(findWidget(node, "output_height")?.value) || 512;
        const outAspect = outW / outH;
        const psdAspect = psdW / psdH;
        let fw, fh;
        if (outAspect >= psdAspect) { fw = psdW; fh = psdW / outAspect; }
        else                        { fh = psdH; fw = psdH * outAspect; }
        const fpx = (psdW - fw) / 2;
        const fpy = (psdH - fh) / 2;
        const cam = this._previewCam;
        const W = this._previewCanvas.width, H = this._previewCanvas.height;
        const toS = (px, py) => ({
            sx: (px - W / 2 + cam.x) * cam.zoom + W / 2,
            sy: (py - H / 2 + cam.y) * cam.zoom + H / 2,
        });
        const tl = toS(fpx, fpy);
        const br = toS(fpx + fw, fpy + fh);
        return { sx: tl.sx, sy: tl.sy, sw: br.sx - tl.sx, sh: br.sy - tl.sy, outW, outH };
    }

    _updateRigModeUI(setupBar) {
        this._btnSetup.style.outline = (this._rigMode === 'setup') ? `2px solid #4499ff` : "none";
        this._btnPose.style.outline  = (this._rigMode === 'pose')  ? `2px solid #44ff88` : "none";
        this._setupBar.style.display = (this._rigMode === 'setup') ? "flex" : "none";
        this._poseBar.style.display  = (this._rigMode === 'pose')  ? "flex" : "none";
        this._updatePoseBarUI();
        this._drawPreview();
    }

    _updatePoseBarUI() {
        if (!this._lblBtn) return;
        this._lblBtn.style.outline = this._showRigLabels ? "2px solid #44ff88" : "none";
    }

    _updateSetupBtns() {
        this._btnR.style.outline  = (this._setupPointType === 'r')  ? "2px solid #4499ff" : "none";
        this._btnMR.style.outline = (this._setupPointType === 'mr') ? "2px solid #ff3333" : "none";
        this._btnSW.style.outline = (this._setupPointType === 'sw') ? "2px solid #44cc44" : "none";
    }

    _deleteSelectedRig() {
        const ids = this._selectedCgId ? [this._selectedCgId] : [...this.selectedIds];
        for (const id of ids) {
            delete this.state.rigging[id];
            delete this.state.pose[id];
        }
        this._drawPreview();
    }

    // ---- SW（スイッチ）関連メソッド ----

    _nextSwPointName() {
        let idx = 1;
        const used = new Set();
        for (const l of this.state.swLayers) for (const p of l.points) used.add(p.name);
        while (used.has(`sw${idx}`)) idx++;
        return `sw${idx}`;
    }

    _placeSwPoint(wx, wy) {
        const swLayer = this.state.swLayers.find(l => l.id === this._selectedSwLayerId);
        if (!swLayer) return;
        const pt = {
            id: `swp_${Math.random().toString(36).slice(2)}`,
            name: this._nextSwPointName(),
            x: Math.round(wx),
            y: Math.round(wy),
            radius: 80,
            angle: 0,
            groups: [],
        };
        swLayer.points.push(pt);
        this._selectedSwPointInfo = { swLayerId: swLayer.id, pointId: pt.id };
        // 配置後SWボタンを解除
        this._setupPointType = null;
        this._updateSetupBtns();
        if (this._activeTab === 'switch') this._renderSwitchTab();
        this._renderLayerTab();
    }

    _renderSwitchTab() {
        if (!this._switchListEl || !this._switchGroupEl) return;
        this._switchListEl.innerHTML = "";

        for (const swLayer of this.state.swLayers) {
            // SWレイヤーヘッダー
            const layerRow = document.createElement("div");
            layerRow.style.cssText = "padding:3px 8px;font-size:11px;color:#a78bfa;background:#1a1a2e;border-left:3px solid #7c3aed;display:flex;align-items:center;gap:4px;";
            layerRow.textContent = `${t("swPrefix")} ${swLayer.name}`;
            this._switchListEl.appendChild(layerRow);

            for (const pt of swLayer.points) {
                const isPtSel = this._selectedSwPointInfo?.swLayerId === swLayer.id
                             && this._selectedSwPointInfo?.pointId === pt.id;
                const row = document.createElement("div");
                row.className = "psd-layer-item" + (isPtSel ? " selected" : "");
                row.style.cssText = "padding:3px 10px 3px 20px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;";

                // SWポイント名（ダブルクリックで名前変更）
                const nameEl = document.createElement("span");
                nameEl.className = "layer-name";
                nameEl.textContent = pt.name;
                nameEl.title = t("clickSelectDblRename");
                let clickTimer = null;
                nameEl.addEventListener("click", e => {
                    e.stopPropagation();
                    if (clickTimer) return;
                    clickTimer = setTimeout(() => {
                        clickTimer = null;
                        this._selectedSwPointInfo = isPtSel ? null : { swLayerId: swLayer.id, pointId: pt.id };
                        this._renderSwitchTab();
                        this._drawPreview();
                    }, 250);
                });
                nameEl.addEventListener("dblclick", e => {
                    e.stopPropagation();
                    clearTimeout(clickTimer); clickTimer = null;
                    this._selectedSwPointInfo = { swLayerId: swLayer.id, pointId: pt.id };
                    const input = document.createElement("input");
                    input.value = pt.name;
                    input.style.cssText = "width:90px;background:#313244;border:1px solid #89b4fa;border-radius:3px;color:#cdd6f4;padding:1px 6px;font-size:12px;outline:none;";
                    nameEl.replaceWith(input); input.focus(); input.select();
                    const commit = () => {
                        if (!input.isConnected) return;
                        const v = input.value.trim(); if (v) pt.name = v;
                        nameEl.textContent = pt.name; input.replaceWith(nameEl); this._drawPreview();
                    };
                    input.addEventListener("blur", commit);
                    input.addEventListener("keydown", ev => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") input.replaceWith(nameEl); });
                });

                // SWポイント削除ボタン
                const delBtn = document.createElement("button");
                delBtn.className = "psd-btn";
                delBtn.textContent = "✕";
                delBtn.style.cssText = "padding:1px 5px;font-size:10px;margin-left:auto;flex-shrink:0;";
                delBtn.title = t("deleteSwPointTooltip");
                delBtn.onclick = e => {
                    e.stopPropagation();
                    swLayer.points = swLayer.points.filter(p => p.id !== pt.id);
                    if (isPtSel) this._selectedSwPointInfo = null;
                    this._renderSwitchTab();
                    this._renderLayerTab();
                    this._drawPreview();
                };

                row.append(nameEl, delBtn);
                row.addEventListener("click", e => {
                    if (e.target === nameEl) return;
                    this._selectedSwPointInfo = isPtSel ? null : { swLayerId: swLayer.id, pointId: pt.id };
                    this._renderSwitchTab();
                    this._drawPreview();
                });
                this._switchListEl.appendChild(row);

                // 選択中SWポイントのgroupsリスト展開
                if (isPtSel) {
                    let slotOffset = 0;
                    for (let i = 0; i < pt.groups.length; i++) {
                        const entry = pt.groups[i];
                        const isPsdGroup    = entry?.type === 'psd_group';
                        const isCustomGroup = entry?.type === 'custom_group';
                        const isComposite   = (isPsdGroup || isCustomGroup) && entry?.mode === 'composite';
                        const cgObj = isCustomGroup
                            ? this.state.customGroups.find(g => g.id === entry.id) ?? null
                            : null;
                        const leaves = isPsdGroup    ? getPsdGroupLeaves(entry.id, this.layerTree)
                                     : isCustomGroup ? (cgObj?.layer_ids || [])
                                     : null;
                        const slotCount = isComposite ? 1
                                        : (isPsdGroup || isCustomGroup) ? (leaves?.length ?? 0) : 1;
                        const isOrphaned = (isPsdGroup || isCustomGroup) && (leaves?.length ?? 0) === 0;
                        const isGSel = i === this._selectedSwGroupIdx;

                        const gRow = document.createElement("div");
                        gRow.className = "psd-layer-item" + (isGSel ? " selected" : "");
                        gRow.style.cssText = "padding:3px 10px 3px 32px;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:4px;"
                            + (isOrphaned ? "background:rgba(180,40,40,0.18);outline:1px solid rgba(200,60,60,0.5);" : "");

                        const typeBadge = document.createElement("span");
                        typeBadge.style.cssText = "flex-shrink:0;font-size:10px;font-weight:bold;padding:1px 3px;border-radius:2px;margin-right:2px;";
                        if (typeof entry === 'string') {
                            typeBadge.textContent = "L"; typeBadge.style.background = "#2a2a4a"; typeBadge.style.color = "#89b4fa";
                        } else if (isComposite) {
                            typeBadge.textContent = "C"; typeBadge.style.background = "#3a2515"; typeBadge.style.color = "#fab387";
                        } else {
                            typeBadge.textContent = "P"; typeBadge.style.background = "#152535"; typeBadge.style.color = "#89dceb";
                        }

                        const stepLabel = document.createElement("span");
                        stepLabel.style.cssText = "color:#888;flex-shrink:0;width:52px;text-align:right;font-size:10px;";
                        if (isOrphaned) {
                            stepLabel.textContent = "-";
                            stepLabel.style.color = "#cc4444";
                        } else if (!isComposite && (isPsdGroup || isCustomGroup) && slotCount > 1) {
                            stepLabel.textContent = `${slotOffset * 30}°-${(slotOffset + slotCount - 1) * 30}°`;
                        } else {
                            stepLabel.textContent = `${slotOffset * 30}°`;
                        }

                        const entryId  = typeof entry === 'string' ? entry : entry?.id;
                        const entryVal = isPsdGroup    ? `psd_group:${entryId}`
                                       : isCustomGroup ? `cg:${entryId}`
                                       : entryId;

                        const cgSel = document.createElement("select");
                        cgSel.style.cssText = "flex:1;background:#252535;border:1px solid #4a4a66;color:#cdd6f4;padding:2px 4px;border-radius:3px;font-size:11px;";

                        if (typeof entry === 'string') {
                            // +L エントリ: レイヤーのみ
                            const addLayerOpts = (nodes) => {
                                for (const n of nodes) {
                                    if (n.kind === "group" && n.children) { addLayerOpts(n.children); continue; }
                                    const opt = document.createElement("option");
                                    const clipMark = n.clipping ? " ✂" : "";
                                    opt.value = n.id; opt.textContent = `${t("layerPrefix")} ${this.state.renamed[n.id] ?? n.name}${clipMark}`;
                                    if (n.id === entryVal) opt.selected = true;
                                    cgSel.appendChild(opt);
                                }
                            };
                            addLayerOpts(this.layerTree);
                        } else {
                            // +P / +C エントリ: グループ/フォルダのみ
                            for (const cg2 of this.state.customGroups) {
                                const opt = document.createElement("option");
                                const cgVal = `cg:${cg2.id}`;
                                opt.value = cgVal; opt.textContent = `${t("groupPrefix")} ${cg2.name}`;
                                if (cgVal === entryVal) opt.selected = true;
                                cgSel.appendChild(opt);
                            }
                            const addGroupOpts = (nodes) => {
                                for (const n of nodes) {
                                    if (n.kind === 'group' && n.children) {
                                        const opt = document.createElement("option");
                                        const psdVal = `psd_group:${n.id}`;
                                        opt.value = psdVal;
                                        opt.textContent = `${t("psdGroupPrefix")} ${this.state.renamed[n.id] ?? n.name}`;
                                        if (psdVal === entryVal) opt.selected = true;
                                        cgSel.appendChild(opt);
                                        addGroupOpts(n.children);
                                    }
                                }
                            };
                            addGroupOpts(this.layerTree);
                        }

                        cgSel.addEventListener("change", () => {
                            const val = cgSel.value;
                            const entryMode = entry?.mode ?? 'piece';
                            if (val.startsWith('psd_group:')) {
                                const gid2 = val.slice('psd_group:'.length);
                                const tempGroups = [...pt.groups];
                                tempGroups[i] = { type: 'psd_group', id: gid2, mode: entryMode };
                                if (countSwSlots(tempGroups, this.layerTree, this.state.customGroups) > 12) {
                                    alert(t("maxGroupsReached"));
                                    cgSel.value = entryVal;
                                    return;
                                }
                                pt.groups[i] = { type: 'psd_group', id: gid2, mode: entryMode };
                            } else if (val.startsWith('cg:')) {
                                const cgId = val.slice(3);
                                const tempGroups = [...pt.groups];
                                tempGroups[i] = { type: 'custom_group', id: cgId, mode: entryMode };
                                if (countSwSlots(tempGroups, this.layerTree, this.state.customGroups) > 12) {
                                    alert(t("maxGroupsReached"));
                                    cgSel.value = entryVal;
                                    return;
                                }
                                pt.groups[i] = { type: 'custom_group', id: cgId, mode: entryMode };
                            } else {
                                pt.groups[i] = val;
                            }
                            this._renderSwitchTab();
                            this._drawPreview();
                        });
                        cgSel.addEventListener("click", e => e.stopPropagation());

                        gRow.addEventListener("click", () => {
                            this._selectedSwGroupIdx = isGSel ? -1 : i;
                            this._renderSwitchTab();
                        });
                        if (isOrphaned) {
                            const warn = document.createElement("span");
                            warn.textContent = "⚠";
                            warn.title = t("swGroupOrphaned");
                            warn.style.cssText = "color:#cc4444;flex-shrink:0;font-size:11px;";
                            gRow.append(typeBadge, stepLabel, cgSel, warn);
                        } else {
                            gRow.append(typeBadge, stepLabel, cgSel);
                        }
                        this._switchListEl.appendChild(gRow);

                        slotOffset += slotCount;
                    }
                }
            }
        }

        this._switchGroupEl.innerHTML = "";
    }

    _addSwGroup(mode) {
        const info = this._selectedSwPointInfo;
        if (!info) return;
        const swLayer = this.state.swLayers.find(l => l.id === info.swLayerId);
        const pt = swLayer?.points?.find(p => p.id === info.pointId);
        if (!pt) return;
        if (countSwSlots(pt.groups, this.layerTree, this.state.customGroups) >= 12) { alert(t("maxGroupsReached")); return; }
        if (mode === 'layer') {
            const find = ns => { for (const n of ns) { if (n.kind !== "group") return n; if (n.children) { const f = find(n.children); if (f) return f; } } return null; };
            const firstLayer = find(this.layerTree);
            if (!firstLayer) { alert(t("noAssignableLayer")); return; }
            pt.groups.push(firstLayer.id);
        } else {
            const firstCg = this.state.customGroups[0];
            const findGrp = ns => { for (const n of ns) { if (n.kind === 'group' && n.children) return n; if (n.children) { const f = findGrp(n.children); if (f) return f; } } return null; };
            const firstPsdGroup = findGrp(this.layerTree);
            if (!firstCg && !firstPsdGroup) { alert(t("noAssignableGroup")); return; }
            pt.groups.push(firstCg
                ? { type: 'custom_group', id: firstCg.id, mode }
                : { type: 'psd_group', id: firstPsdGroup.id, mode });
        }
        this._selectedSwGroupIdx = pt.groups.length - 1;
        this._renderSwitchTab();
        this._drawPreview();
    }

    _removeSwGroup() {
        const info = this._selectedSwPointInfo;
        if (!info) return;
        const swLayer = this.state.swLayers.find(l => l.id === info.swLayerId);
        const pt = swLayer?.points?.find(p => p.id === info.pointId);
        if (!pt) return;
        const idx = this._selectedSwGroupIdx;
        if (idx < 0 || idx >= pt.groups.length) return;
        pt.groups.splice(idx, 1);
        this._selectedSwGroupIdx = Math.min(idx, pt.groups.length - 1);
        this._renderSwitchTab();
        this._drawPreview();
    }

    _getSelectedLayerId() {
        return this._selectedCgId ?? [...this.selectedIds][0] ?? null;
    }

    // セットアップ/ポージング モードのインタラクション設定（パン・ズーム含む）
    _setupRigInteraction() {
        const canvas = this._previewCanvas;
        let dragInfo  = null;
        let isPanning = false;
        let lastMX = 0, lastMY = 0;

        // canvas CSS座標 → PSD（ワールド）座標（カメラ変換を逆算）
        const toPsd = (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = (e.clientX - rect.left) * (canvas.width  / rect.width);
            const sy = (e.clientY - rect.top)  * (canvas.height / rect.height);
            const cam = this._previewCam;
            const W = canvas.width, H = canvas.height;
            return {
                x: (sx - W / 2) / cam.zoom + W / 2 - cam.x,
                y: (sy - H / 2) / cam.zoom + H / 2 - cam.y,
            };
        };

        canvas.addEventListener("mousedown", (e) => {
            lastMX = e.clientX; lastMY = e.clientY;

            if (this._rigMode === 'normal') {
                isPanning = true;
                canvas.style.cursor = "grabbing";
                e.preventDefault(); e.stopPropagation();
                return;
            }

            const { x: wx, y: wy } = toPsd(e);

            if (this._rigMode === 'setup') {
                if (e.button === 2) { isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault(); return; }
                const imageMap = this._getEffectiveImageMap();

                if (this._setupPointType === 'sw') {
                    // SWモード: SWポイントへのヒットテスト（ドラッグ）or 新規配置
                    const hit = hitTestRig(wx, wy, this.layerTree, imageMap,
                                           this.state.rigging, this.state.pose, 'setup', this._previewCam.zoom,
                                           this.state.layerParent, this.state.customGroups, this._rigPointSize ?? 1.0, this.state.swLayers);
                    if (hit && (hit.type === 'sw_handle' || hit.type === 'sw_origin')) {
                        this._selectedSwPointInfo = { swLayerId: hit.swLayerId, pointId: hit.swPointId };
                        dragInfo = { mode: 'setup_drag', hit };
                        canvas.style.cursor = "crosshair";
                        e.preventDefault(); e.stopPropagation();
                    } else if (this._selectedSwPointInfo) {
                        // 選択済みSWポイントの原点付近をクリックした場合は移動ドラッグ開始
                        const selInfo = this._selectedSwPointInfo;
                        const selSwL = this.state.swLayers.find(l => l.id === selInfo.swLayerId);
                        const selPt  = selSwL?.points?.find(p => p.id === selInfo.pointId);
                        const bonusR = 28 / (this._previewCam.zoom ?? 1) * (this._rigPointSize ?? 1.0);
                        if (selPt && Math.hypot(wx - (selPt.x ?? 0), wy - (selPt.y ?? 0)) < bonusR) {
                            dragInfo = { mode: 'setup_drag', hit: { swLayerId: selInfo.swLayerId, swPointId: selInfo.pointId, type: 'sw_origin' } };
                            canvas.style.cursor = "crosshair";
                            e.preventDefault(); e.stopPropagation();
                        } else if (this._selectedSwLayerId) {
                            this._placeSwPoint(wx, wy);
                            this._drawPreview();
                            e.preventDefault(); e.stopPropagation();
                        } else {
                            isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault();
                        }
                    } else if (this._selectedSwLayerId) {
                        this._placeSwPoint(wx, wy);
                        this._drawPreview();
                        e.preventDefault(); e.stopPropagation();
                    } else {
                        isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault();
                    }
                } else {
                    const selId = this._getSelectedLayerId();
                    if (!selId) { isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault(); return; }
                    const entry = imageMap[selId];
                    if (!entry) { isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault(); return; }
                    const hit = hitTestRig(wx, wy, this.layerTree, imageMap,
                                           this.state.rigging, this.state.pose, 'setup', this._previewCam.zoom,
                                           this.state.layerParent, this.state.customGroups, this._rigPointSize ?? 1.0, this.state.swLayers);
                    if (hit && hit.layerId === selId) {
                        dragInfo = { mode: 'setup_drag', hit };
                        canvas.style.cursor = "crosshair";
                        e.preventDefault(); e.stopPropagation();
                    } else {
                        this._placeSetupPoint(selId, wx, wy, entry);
                        this._drawPreview();
                        e.preventDefault(); e.stopPropagation();
                    }
                }
            } else if (this._rigMode === 'pose') {
                const imageMap = this._getEffectiveImageMap();
                const hit = hitTestRig(wx, wy, this.layerTree, imageMap,
                                       this.state.rigging, this.state.pose, 'pose', this._previewCam.zoom,
                                       this.state.layerParent, this.state.customGroups, this._rigPointSize ?? 1.0, this.state.swLayers);
                if (hit && (e.altKey || e.ctrlKey) && (hit.type === 'r' || hit.type === 'mr')) {
                    if (!this.state.pose[hit.layerId]) this.state.pose[hit.layerId] = { angle: 0, tx: 0, ty: 0 };
                    const p = this.state.pose[hit.layerId];
                    if (e.altKey)  p.flipX = !p.flipX;
                    if (e.ctrlKey) p.flipY = !p.flipY;
                    this._drawPreview();
                    e.preventDefault(); e.stopPropagation();
                } else if (hit && hit.type === 'sw_handle') {
                    // SWハンドル: 角度を変えてグループ切り替え
                    const swLayer = this.state.swLayers.find(l => l.id === hit.swLayerId);
                    const swInfo = swLayer?.points?.find(p => p.id === hit.swPointId);
                    if (swInfo) {
                        this._selectedSwPointInfo = { swLayerId: hit.swLayerId, pointId: hit.swPointId };
                        dragInfo = { mode: 'sw_pose_drag', hit,
                                     pivotX: swInfo.x ?? 0,
                                     pivotY: swInfo.y ?? 0 };
                        canvas.style.cursor = "crosshair";
                        e.preventDefault(); e.stopPropagation();
                    } else { isPanning = true; canvas.style.cursor = "grabbing"; e.preventDefault(); e.stopPropagation(); }
                } else if (hit) {
                    const rig = this.state.rigging[hit.layerId];
                    const entry = imageMap[hit.layerId];
                    const p = this.state.pose[hit.layerId] || { angle: 0, tx: 0, ty: 0 };
                    let pivotX = 0, pivotY = 0, initAngle = 0;
                    // 子レイヤーは祖先トランスフォーム適用後の視覚座標をピボットに使う
                    const chain = buildAncestorChain(hit.layerId, this.state.layerParent,
                                                     this.state.rigging, this.state.pose, imageMap);
                    if (hit.type === 'r' && rig.r) {
                        const local = { x: entry.left + rig.r.x + (p.tx ?? 0), y: entry.top + rig.r.y + (p.ty ?? 0) };
                        const vis = chain.length > 0 ? applyChainToPoint(local.x, local.y, chain) : local;
                        pivotX = vis.x; pivotY = vis.y;
                        initAngle = Math.atan2(wy - pivotY, wx - pivotX);
                    } else if (hit.type === 'mr' && rig.mr) {
                        const local = { x: entry.left + rig.mr.x, y: entry.top + rig.mr.y };
                        const vis = chain.length > 0 ? applyChainToPoint(local.x, local.y, chain) : local;
                        pivotX = vis.x; pivotY = vis.y;
                        initAngle = Math.atan2(wy - pivotY, wx - pivotX);
                    }
                    dragInfo = { mode: 'pose_drag', hit, pivotX, pivotY,
                                 initAngle, startAngle: p.angle ?? 0,
                                 startTx: p.tx ?? 0, startTy: p.ty ?? 0 };
                    canvas.style.cursor = "crosshair";
                    e.preventDefault(); e.stopPropagation();
                } else {
                    isPanning = true;
                    canvas.style.cursor = "grabbing";
                    e.preventDefault(); e.stopPropagation();
                }
            }
        });

        canvas.addEventListener("mousemove", (e) => {
            if (isPanning) {
                const rect   = canvas.getBoundingClientRect();
                const scaleX = canvas.width  / rect.width;
                const scaleY = canvas.height / rect.height;
                const cam    = this._previewCam;
                cam.x += (e.clientX - lastMX) * scaleX / cam.zoom;
                cam.y += (e.clientY - lastMY) * scaleY / cam.zoom;
                lastMX = e.clientX; lastMY = e.clientY;
                this._drawPreview();
                return;
            }

            if (!dragInfo) return;
            const { x: wx, y: wy } = toPsd(e);

            if (dragInfo.mode === 'setup_drag') {
                const { hit } = dragInfo;

                if (hit.type === 'sw_handle' || hit.type === 'sw_origin') {
                    // SWポイントのドラッグ
                    const swLayer = this.state.swLayers.find(l => l.id === hit.swLayerId);
                    const sw = swLayer?.points?.find(p => p.id === hit.swPointId);
                    if (sw) {
                        if (hit.type === 'sw_handle') {
                            const oX = sw.x ?? 0;
                            const oY = sw.y ?? 0;
                            sw.radius = Math.max(20, Math.round(Math.hypot(wx - oX, wy - oY)));
                            sw.angle  = Math.atan2(wy - oY, wx - oX);
                        } else {
                            sw.x = Math.round(wx);
                            sw.y = Math.round(wy);
                        }
                    }
                } else {
                    const selId = hit.layerId;
                    const entry = this._getEffectiveImageMap()[selId];
                    if (!entry) return;
                    if (!this.state.rigging[selId]) this.state.rigging[selId] = {
                        r:         { x: entry.width / 2, y: entry.height / 2 },
                        mr:        { x: entry.width / 2, y: entry.height / 2 },
                        mr_radius: 0,
                    };
                    const rig = this.state.rigging[selId];
                    if (hit.type === 'r') {
                        rig.r.x = wx - entry.left;
                        rig.r.y = wy - entry.top;
                    } else if (hit.type === 'mr') {
                        rig.mr.x = wx - entry.left;
                        rig.mr.y = wy - entry.top;
                    } else if (hit.type === 'orange') {
                        const sX = entry.left + rig.mr.x;
                        const sY = entry.top  + rig.mr.y;
                        const dx = wx - sX, dy = wy - sY;
                        rig.mr_radius = Math.max(0, Math.round(Math.hypot(dx, dy)));
                        if (rig.mr_radius > 0) rig.mr_angle = Math.atan2(dy, dx);
                    }
                }
                this._drawPreview();

            } else if (dragInfo.mode === 'pose_drag') {
                const { hit, pivotX, pivotY, initAngle, startAngle, startTx, startTy } = dragInfo;
                const layerId = hit.layerId;
                if (!this.state.pose[layerId]) this.state.pose[layerId] = { angle: 0, tx: 0, ty: 0 };
                const p = this.state.pose[layerId];
                const rig = this.state.rigging[layerId];
                const imageMap = this._getEffectiveImageMap();
                const entry = imageMap[layerId];

                if (hit.type === 'r' || hit.type === 'mr') {
                    const curAngle = Math.atan2(wy - pivotY, wx - pivotX);
                    p.angle = startAngle + (curAngle - initAngle);
                } else if (hit.type === 'orange') {
                    const rawSX = entry.left + rig.mr.x;
                    const rawSY = entry.top  + rig.mr.y;
                    // 祖先トランスフォームがある場合、ドラッグ位置を祖先ローカル空間に逆変換
                    const dChain = buildAncestorChain(layerId, this.state.layerParent,
                                                      this.state.rigging, this.state.pose, imageMap);
                    let localWx = wx, localWy = wy;
                    if (dChain.length > 0) {
                        const inv = inverseChainToPoint(wx, wy, dChain);
                        localWx = inv.x; localWy = inv.y;
                    }
                    let newTx = localWx - rawSX;
                    let newTy = localWy - rawSY;
                    if (rig.mr_radius > 0) {
                        const dist = Math.hypot(newTx, newTy);
                        if (dist > rig.mr_radius) {
                            newTx = newTx / dist * rig.mr_radius;
                            newTy = newTy / dist * rig.mr_radius;
                        }
                    }
                    p.tx = newTx;
                    p.ty = newTy;
                }
                this._drawPreview();
            } else if (dragInfo.mode === 'sw_pose_drag') {
                const { hit, pivotX, pivotY } = dragInfo;
                const swLayer = this.state.swLayers.find(l => l.id === hit.swLayerId);
                const swInfo = swLayer?.points?.find(p => p.id === hit.swPointId);
                if (swInfo) {
                    swInfo.angle = Math.atan2(wy - pivotY, wx - pivotX);
                    this._drawPreview();
                }
            }
        });

        const endDrag = () => {
            dragInfo = null;
            isPanning = false;
            canvas.style.cursor = "grab";
        };
        canvas.addEventListener("mouseup",    endDrag);
        canvas.addEventListener("mouseleave", endDrag);

        // ズーム（カーソル位置中心）
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            const cam     = this._previewCam;
            const oldZoom = cam.zoom;
            const factor  = 1.12;
            cam.zoom = e.deltaY < 0
                ? Math.min(20.0, cam.zoom * factor)
                : Math.max(0.05, cam.zoom / factor);
            const rect  = canvas.getBoundingClientRect();
            const cvsX  = (e.clientX - rect.left) * (canvas.width  / rect.width);
            const cvsY  = (e.clientY - rect.top)  * (canvas.height / rect.height);
            const W = canvas.width, H = canvas.height;
            cam.x += (cvsX - W / 2) * (1 / cam.zoom - 1 / oldZoom);
            cam.y += (cvsY - H / 2) * (1 / cam.zoom - 1 / oldZoom);
            this._drawPreview();
        }, { passive: false });

        canvas.addEventListener("contextmenu", e => e.preventDefault());
    }

    _placeSetupPoint(layerId, wx, wy, entry) {
        if (!this.state.rigging[layerId]) {
            this.state.rigging[layerId] = { mr_radius: 0 };
        }
        const rig = this.state.rigging[layerId];
        const lx = Math.round(wx - entry.left);
        const ly = Math.round(wy - entry.top);
        if (this._setupPointType === 'r') {
            if (!rig.r) rig.r = { x: 0, y: 0 };
            rig.r.x = lx; rig.r.y = ly;
        } else {
            if (!rig.mr) rig.mr = { x: 0, y: 0 };
            rig.mr.x = lx; rig.mr.y = ly;
            if (rig.mr_radius === 0) { rig.mr_radius = 50; rig.mr_angle = 0; }
        }
    }

    _findNodeById(id) {
        const walk = nodes => {
            for (const n of nodes) {
                if (n.id === id) return n;
                if (n.children) { const f = walk(n.children); if (f) return f; }
            }
            return null;
        };
        return walk(this.layerTree);
    }

    _renderTree() {
        this._renderLayerTab();
        this._renderParentTab();
        this._drawPreview();
    }

    // レイヤータブ: 重ね順（cgOrder + CG構造）を表示。layerParent階層は示さない
    _renderLayerTab() {
        this._layerListEl.innerHTML = "";

        // SWレイヤーを先頭に表示
        for (const swLayer of this.state.swLayers) {
            this._layerListEl.appendChild(this._mkSwLayerEl(swLayer));
        }

        const cgMap = {};
        for (const cg of this.state.customGroups) cgMap[cg.id] = cg;

        const itemParent = {};
        for (const cg of this.state.customGroups) {
            for (const lid of cg.layer_ids) itemParent[lid] = cg.id;
        }

        const groupedLayerIds = new Set();
        for (const cg of this.state.customGroups) {
            for (const lid of cg.layer_ids) { if (!cgMap[lid]) groupedLayerIds.add(lid); }
        }

        const walkPsdSubtree = (nodes, depth) => {
            for (const n of [...nodes].reverse()) {
                if (groupedLayerIds.has(n.id)) continue;
                this._layerListEl.appendChild(this._mkLayerEl(n, depth, null));
                if (n.kind === "group" && n.children && !this.collapsedIds.has(n.id)) walkPsdSubtree(n.children, depth + 1);
            }
        };

        const renderCg = (cg, depth) => {
            const parentCgId = itemParent[cg.id] || null;
            this._layerListEl.appendChild(this._mkCustomGroupEl(cg, depth, parentCgId));
            if (!this.collapsedIds.has(cg.id)) {
                for (const lid of cg.layer_ids) {
                    if (cgMap[lid]) {
                        renderCg(cgMap[lid], depth + 1);
                    } else {
                        const node = this._findNodeById(lid);
                        if (node) this._layerListEl.appendChild(this._mkLayerEl(node, depth + 1, cg.id));
                    }
                }
                if (cg.layer_ids.length === 0) {
                    const empty = document.createElement("div");
                    empty.className = "psd-group-empty";
                    empty.textContent = t("dropLayerHere");
                    empty.style.paddingLeft = `${12 + (depth + 1) * 16}px`;
                    empty.addEventListener("dragover",  e => { e.preventDefault(); empty.classList.add("drag-over"); });
                    empty.addEventListener("dragleave", () => empty.classList.remove("drag-over"));
                    empty.addEventListener("drop", e => {
                        e.preventDefault(); empty.classList.remove("drag-over");
                        if (this._dragSrcId) this._moveItemToGroup(this._dragSrcId, cg.id);
                    });
                    this._layerListEl.appendChild(empty);
                }
            }
        };

        const topPsdNodes = {};
        for (const n of this.layerTree) topPsdNodes[n.id] = n;
        const shown = new Set();

        for (const id of this.state.cgOrder) {
            if (cgMap[id] && !itemParent[id]) {
                renderCg(cgMap[id], 0);
                shown.add(id);
            } else if (topPsdNodes[id] && !groupedLayerIds.has(id)) {
                const n = topPsdNodes[id];
                this._layerListEl.appendChild(this._mkLayerEl(n, 0, null));
                if (n.kind === "group" && n.children && !this.collapsedIds.has(n.id)) walkPsdSubtree(n.children, 1);
                shown.add(id);
            }
        }

        for (const cg of this.state.customGroups) {
            if (!itemParent[cg.id] && !shown.has(cg.id)) renderCg(cg, 0);
        }
        for (const n of [...this.layerTree].reverse()) {
            if (!shown.has(n.id) && !groupedLayerIds.has(n.id)) {
                this._layerListEl.appendChild(this._mkLayerEl(n, 0, null));
                if (n.kind === "group" && n.children && !this.collapsedIds.has(n.id)) walkPsdSubtree(n.children, 1);
            }
        }
    }

    // ペアレントタブ: layerParent 親子関係をツリー表示。折りたたみ対応
    _renderParentTab() {
        this._parentListEl.innerHTML = "";

        const rendered = new Set();
        const renderRow = (layerId, depth) => {
            if (rendered.has(layerId)) return;
            rendered.add(layerId);

            // PSDレイヤー or カスタムグループを解決
            const psdNode = this._findNodeById(layerId);
            const cgNode  = psdNode ? null : this.state.customGroups.find(g => g.id === layerId);
            if (!psdNode && !cgNode) return;

            const isCg      = !!cgNode;
            const vis       = isCg ? (cgNode.visible !== false) : (this.state.visibility[layerId] !== false);
            const sel       = isCg ? (this._selectedCgId === layerId) : this.selectedIds.has(layerId);
            const children  = this._ptGetChildren(layerId);
            const collapsed = this.collapsedIds.has(layerId);

            const row = document.createElement("div");
            row.className = "psd-layer-item" + (sel ? " selected" : "") + (!vis ? " hidden-layer" : "");
            row.dataset.id = layerId;
            row.style.paddingLeft = `${12 + depth * 16}px`;

            row.addEventListener("click", () => {
                if (isCg) {
                    this.selectedIds.clear();
                    this._selectedCgId = (this._selectedCgId === layerId) ? null : layerId;
                } else {
                    this._selectedCgId = null;
                    this.selectedIds.clear();
                    this.selectedIds.add(layerId);
                }
                this._renderTree();
            });

            const eye = document.createElement("span");
            eye.className = "eye-btn";
            eye.textContent = vis ? "👁" : "🚫";
            eye.addEventListener("click", e => {
                e.stopPropagation();
                if (isCg) cgNode.visible = !vis; else this.state.visibility[layerId] = !vis;
                this._renderTree();
            });
            row.appendChild(eye);

            if (children.length > 0) {
                const tog = document.createElement("span");
                tog.className = "toggle-btn";
                tog.textContent = collapsed ? "▶" : "▼";
                tog.addEventListener("click", e => {
                    e.stopPropagation();
                    collapsed ? this.collapsedIds.delete(layerId) : this.collapsedIds.add(layerId);
                    this._renderTree();
                });
                row.appendChild(tog);
            }

            const icon = document.createElement("span");
            icon.className = "kind-icon";
            icon.textContent = isCg ? "📂" : (psdNode.kind === "group" ? "📁" : "🖼");
            row.appendChild(icon);

            const nameEl = document.createElement("span");
            nameEl.className = "layer-name";
            nameEl.textContent = isCg
                ? `[CG] ${cgNode.name}`
                : (this.state.renamed[layerId] ?? psdNode.name);
            if (!isCg) nameEl.addEventListener("dblclick", e => { e.stopPropagation(); this._inlineRename(nameEl, layerId); });
            row.appendChild(nameEl);

            this._parentListEl.appendChild(row);

            if (children.length > 0 && !collapsed) {
                for (const childId of children) renderRow(childId, depth + 1);
            }
        };

        for (const id of this._ptGetRoots()) renderRow(id, 0);
    }

    _mkLayerEl(node, depth, groupId) {
        const vis = this.state.visibility[node.id] !== false;
        const sel = this.selectedIds.has(node.id);

        const row = document.createElement("div");
        row.className = "psd-layer-item"
            + (sel ? " selected" : "")
            + (!vis ? " hidden-layer" : "")
            + (groupId ? " in-custom-group" : "");
        row.dataset.id = node.id;
        if (groupId) row.dataset.groupId = groupId;
        row.draggable = true;
        row.style.paddingLeft = `${12 + depth * 16}px`;

        row.addEventListener("dragstart", e => {
            this._dragSrcId = node.id; this._dragSrcCgId = groupId;
            e.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragover",  e => { e.preventDefault(); row.classList.add("drag-over"); });
        row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
        row.addEventListener("drop", e => {
            e.preventDefault(); row.classList.remove("drag-over");
            const srcId = this._dragSrcId, srcCgId = this._dragSrcCgId;
            this._dragSrcId = null; this._dragSrcCgId = null;
            if (!srcId || srcId === node.id) return;
            const tgtCgId = row.dataset.groupId || null;
            if (tgtCgId)        this._moveItemToGroup(srcId, tgtCgId);
            else if (srcCgId) { this._removeItemFromGroup(srcId, srcCgId); this._reorder(srcId, node.id); }
            else               this._reorder(srcId, node.id);
        });

        let singleClickTimer = null;
        row.addEventListener("click", e => {
            if (e.target === nameEl) {
                // nameEl クリックは dblclick のために遅延させる
                clearTimeout(singleClickTimer);
                singleClickTimer = setTimeout(() => {
                    singleClickTimer = null;
                    this._selectedCgId = null; this._selectedSwLayerId = null;
                    const curSel = this.selectedIds.has(node.id);
                    if (e.ctrlKey || e.metaKey) { curSel ? this.selectedIds.delete(node.id) : this.selectedIds.add(node.id); }
                    else { this.selectedIds.clear(); this.selectedIds.add(node.id); }
                    this._renderTree();
                }, 250);
            } else {
                clearTimeout(singleClickTimer);
                singleClickTimer = null;
                this._selectedCgId = null; this._selectedSwLayerId = null;
                if (e.ctrlKey || e.metaKey) { sel ? this.selectedIds.delete(node.id) : this.selectedIds.add(node.id); }
                else { this.selectedIds.clear(); this.selectedIds.add(node.id); }
                this._renderTree();
            }
        });

        const handle = document.createElement("span"); handle.className = "handle"; handle.textContent = "≡"; row.appendChild(handle);

        const eye = document.createElement("span"); eye.className = "eye-btn"; eye.textContent = vis ? "👁" : "🚫";
        eye.addEventListener("click", e => { e.stopPropagation(); this.state.visibility[node.id] = !vis; this._renderTree(); });
        row.appendChild(eye);

        if (node.kind === "group") {
            const tog = document.createElement("span"); tog.className = "toggle-btn";
            tog.textContent = this.collapsedIds.has(node.id) ? "▶" : "▼";
            tog.addEventListener("click", e => { e.stopPropagation(); this.collapsedIds.has(node.id) ? this.collapsedIds.delete(node.id) : this.collapsedIds.add(node.id); this._renderTree(); });
            row.appendChild(tog);
        }

        const icon = document.createElement("span"); icon.className = "kind-icon"; icon.textContent = node.kind === "group" ? "📁" : "🖼"; row.appendChild(icon);

        if (node.clipping) {
            const clipBadge = document.createElement("span");
            clipBadge.textContent = "✂";
            clipBadge.title = t("clippingLayerBadge");
            clipBadge.style.cssText = "font-size:9px;color:#f9e2af;opacity:0.8;margin-right:2px;cursor:default;";
            row.appendChild(clipBadge);
        }

        const nameEl = document.createElement("span"); nameEl.className = "layer-name";
        nameEl.textContent = this.state.renamed[node.id] ?? node.name;
        nameEl.title = t("dblClickToRename");
        nameEl.addEventListener("dblclick", e => { e.stopPropagation(); clearTimeout(singleClickTimer); singleClickTimer = null; this._inlineRename(nameEl, node.id); });
        row.appendChild(nameEl);

        return row;
    }

    _mkCustomGroupEl(cg, depth = 0, parentCgId = null) {
        const vis       = cg.visible !== false;
        const collapsed = this.collapsedIds.has(cg.id);
        const isSel     = this._selectedCgId === cg.id;

        const row = document.createElement("div");
        row.className = "psd-custom-group"
            + (!vis ? " hidden-layer" : "")
            + (isSel ? " selected" : "")
            + (parentCgId ? " in-custom-group" : "");
        row.dataset.cgId = cg.id;
        if (parentCgId) row.dataset.groupId = parentCgId;
        row.style.paddingLeft = `${12 + depth * 16}px`;
        row.draggable = true;

        row.addEventListener("dragstart", e => {
            this._dragSrcId = cg.id; this._dragSrcCgId = parentCgId;
            e.dataTransfer.effectAllowed = "move";
            e.stopPropagation();
        });
        row.addEventListener("dragover",  e => { e.preventDefault(); e.stopPropagation(); row.classList.add("drag-over"); });
        row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
        row.addEventListener("drop", e => {
            e.preventDefault(); e.stopPropagation(); row.classList.remove("drag-over");
            const srcId = this._dragSrcId;
            if (!srcId || srcId === cg.id) return;
            this._moveItemToGroup(srcId, cg.id);
        });

        let cgClickTimer = null;
        row.addEventListener("click", e => {
            if (["eye-btn","toggle-btn","handle"].some(c => e.target.classList.contains(c))) return;
            if (e.target === nameEl) {
                clearTimeout(cgClickTimer);
                cgClickTimer = setTimeout(() => {
                    cgClickTimer = null;
                    this.selectedIds.clear(); this._selectedCgId = isSel ? null : cg.id; this._selectedSwLayerId = null; this._renderTree();
                }, 250);
            } else {
                clearTimeout(cgClickTimer); cgClickTimer = null;
                this.selectedIds.clear(); this._selectedCgId = isSel ? null : cg.id; this._selectedSwLayerId = null; this._renderTree();
            }
        });

        const handle = document.createElement("span"); handle.className = "handle"; handle.textContent = "≡"; row.appendChild(handle);
        const eye = document.createElement("span"); eye.className = "eye-btn"; eye.textContent = vis ? "👁" : "🚫";
        eye.addEventListener("click", e => { e.stopPropagation(); cg.visible = !vis; this._renderTree(); });
        row.appendChild(eye);
        const tog = document.createElement("span"); tog.className = "toggle-btn"; tog.textContent = collapsed ? "▶" : "▼";
        tog.addEventListener("click", e => { e.stopPropagation(); collapsed ? this.collapsedIds.delete(cg.id) : this.collapsedIds.add(cg.id); this._renderTree(); });
        row.appendChild(tog);
        const icon = document.createElement("span"); icon.textContent = "📂"; icon.style.flexShrink = "0"; row.appendChild(icon);

        const nameEl = document.createElement("span"); nameEl.className = "cg-name";
        nameEl.textContent = `${t("customPrefix")} ${cg.name}`; nameEl.title = t("dblClickToRename");
        nameEl.addEventListener("dblclick", e => {
            e.stopPropagation();
            clearTimeout(cgClickTimer); cgClickTimer = null;
            const input = document.createElement("input");
            input.value = cg.name;
            input.style.cssText = "width:120px;background:#313244;border:1px solid #89b4fa;border-radius:3px;color:#f38ba8;padding:1px 6px;font-size:12px;outline:none;";
            nameEl.replaceWith(input); input.focus(); input.select();
            const commit = () => { if (!input.isConnected) return; const v = input.value.trim(); if (v) cg.name = v; nameEl.textContent = `${t("customPrefix")} ${cg.name}`; input.replaceWith(nameEl); };
            input.addEventListener("blur", commit);
            input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") input.replaceWith(nameEl); });
        });
        row.appendChild(nameEl);
        const badge = document.createElement("span"); badge.className = "cg-badge"; badge.textContent = cg.layer_ids.length; row.appendChild(badge);
        return row;
    }

    _mkSwLayerEl(swLayer) {
        const isSel = this._selectedSwLayerId === swLayer.id;

        const row = document.createElement("div");
        row.className = "psd-custom-group" + (isSel ? " selected" : "");
        row.style.cssText = `padding-left:12px;background:${isSel ? "#2a1a3a" : "#1a1a2e"};border-left:3px solid #7c3aed;cursor:pointer;`;

        let clickTimer = null;
        const doSelect = () => {
            const nowSel = this._selectedSwLayerId === swLayer.id;
            this.selectedIds.clear(); this._selectedCgId = null;
            this._selectedSwLayerId = nowSel ? null : swLayer.id;
            this._renderTree();
            if (this._activeTab === 'switch') this._renderSwitchTab();
        };

        row.addEventListener("click", e => {
            if (e.target.classList.contains("eye-btn")) return;
            clearTimeout(clickTimer);
            if (e.target === nameEl) {
                clickTimer = setTimeout(() => { clickTimer = null; doSelect(); }, 250);
            } else {
                doSelect();
            }
        });

        const icon = document.createElement("span"); icon.textContent = "🔀"; icon.style.flexShrink = "0";

        const nameEl = document.createElement("span"); nameEl.className = "cg-name";
        nameEl.textContent = `${t("swPrefix")} ${swLayer.name}`;
        nameEl.style.color = "#a78bfa";
        nameEl.title = t("dblClickToRename");
        nameEl.addEventListener("dblclick", e => {
            e.stopPropagation();
            clearTimeout(clickTimer); clickTimer = null;
            const input = document.createElement("input");
            input.value = swLayer.name;
            input.style.cssText = "width:120px;background:#313244;border:1px solid #7c3aed;border-radius:3px;color:#a78bfa;padding:1px 6px;font-size:12px;outline:none;";
            nameEl.replaceWith(input); input.focus(); input.select();
            const commit = () => {
                if (!input.isConnected) return;
                const v = input.value.trim(); if (v) swLayer.name = v;
                nameEl.textContent = `${t("swPrefix")} ${swLayer.name}`; input.replaceWith(nameEl);
            };
            input.addEventListener("blur", commit);
            input.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); commit(); } if (ev.key === "Escape") input.replaceWith(nameEl); });
        });

        const badge = document.createElement("span"); badge.className = "cg-badge"; badge.textContent = swLayer.points.length;
        row.append(icon, nameEl, badge);

        return row;
    }

    _createSwLayer() {
        let idx = 1;
        const used = new Set(this.state.swLayers.map(l => l.name));
        while (used.has(`SW${idx}`)) idx++;
        const swLayer = { id: `swl_${Math.random().toString(36).slice(2)}`, name: `SW${idx}`, points: [] };
        this.state.swLayers.push(swLayer);
        this._selectedSwLayerId = swLayer.id;
        this._renderTree();
        if (this._activeTab === 'switch') this._renderSwitchTab();
    }

    _deleteSwLayer() {
        const id = this._selectedSwLayerId;
        if (!id) return;
        this.state.swLayers = this.state.swLayers.filter(l => l.id !== id);
        this._selectedSwLayerId = null;
        this._selectedSwPointInfo = null;
        this._renderTree();
        if (this._activeTab === 'switch') this._renderSwitchTab();
        this._drawPreview();
    }

    _moveItemToGroup(itemId, groupId) {
        if (itemId.startsWith('cg_')) {
            const desc = new Set();
            const collectDesc = id => {
                desc.add(id);
                const cg = this.state.customGroups.find(g => g.id === id);
                if (cg) for (const lid of cg.layer_ids) if (lid.startsWith('cg_')) collectDesc(lid);
            };
            collectDesc(itemId);
            if (desc.has(groupId)) return;
            // ルートCGが子CGになる場合、cgOrderから削除
            const oi = this.state.cgOrder.indexOf(itemId);
            if (oi !== -1) this.state.cgOrder.splice(oi, 1);
        }
        // 元のグループから削除 → layer_parent をクリア（元グループのIDだった場合のみ）
        for (const g of this.state.customGroups) {
            if (g.layer_ids.includes(itemId) && !itemId.startsWith('cg_')) {
                if (this.state.layerParent[itemId] === g.id) delete this.state.layerParent[itemId];
            }
            g.layer_ids = g.layer_ids.filter(id => id !== itemId);
        }
        const tgt = this.state.customGroups.find(g => g.id === groupId);
        if (tgt && !tgt.layer_ids.includes(itemId)) {
            tgt.layer_ids.push(itemId);
            // グループのリグ伝播のため layer_parent を自動設定（未設定のもののみ）
            if (!itemId.startsWith('cg_') && !this.state.layerParent[itemId]) {
                this.state.layerParent[itemId] = groupId;
            }
        }
        this._dragSrcId = null; this._dragSrcCgId = null;
        this._renderTree();
    }

    _removeItemFromGroup(itemId, groupId) {
        const g = this.state.customGroups.find(g => g.id === groupId);
        if (g) g.layer_ids = g.layer_ids.filter(id => id !== itemId);
        // layer_parent をクリア（このグループが親だった場合のみ）
        if (!itemId.startsWith('cg_') && this.state.layerParent[itemId] === groupId) {
            delete this.state.layerParent[itemId];
        }
        // CGがルートに戻る場合、cgOrderに追加
        if (itemId.startsWith('cg_') && !this.state.cgOrder.includes(itemId)) {
            this.state.cgOrder.unshift(itemId);
        }
    }

    _inlineRename(nameEl, nodeId) {
        const orig = nameEl.textContent;
        const input = document.createElement("input"); input.value = orig;
        nameEl.replaceWith(input); input.focus(); input.select();
        const commit = () => {
            if (!input.isConnected) return;
            const v = input.value.trim();
            if (v && v !== orig) this.state.renamed[nodeId] = v;
            nameEl.textContent = this.state.renamed[nodeId] ?? orig;
            input.replaceWith(nameEl);
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") input.replaceWith(nameEl); });
    }

    _reorder(srcId, tgtId) {
        // トップレベル（cgOrder）の並べ替え
        const cgOrder = this.state.cgOrder;
        const si = cgOrder.indexOf(srcId);
        const ti = cgOrder.indexOf(tgtId);
        if (si !== -1 && ti !== -1) {
            cgOrder.splice(si, 1);
            cgOrder.splice(cgOrder.indexOf(tgtId), 0, srcId);
            this._renderTree();
            return;
        }
        // PSDサブツリー内の並べ替え
        const move = nodes => {
            const si = nodes.findIndex(n => n.id === srcId), ti = nodes.findIndex(n => n.id === tgtId);
            if (si !== -1 && ti !== -1) { const [item] = nodes.splice(si, 1); nodes.splice(ti, 0, item); return true; }
            for (const n of nodes) { if (n.children && move(n.children)) return true; }
            return false;
        };
        move(this.layerTree);
        this._renderTree();
    }

    _createGroup() {
        const name = prompt(t("promptGroupName"), t("promptGroupDefault", this.state.customGroups.length + 1));
        if (!name) return;
        const cgId = `cg_${Date.now()}`;
        const layer_ids = this.selectedIds.size > 0 ? [...this.selectedIds] : [];
        for (const g of this.state.customGroups) g.layer_ids = g.layer_ids.filter(id => !layer_ids.includes(id));
        const newCg = { id: cgId, name, visible: true, layer_ids };
        this.state.customGroups.push(newCg);

        // グループ内レイヤーの layer_parent を自動設定（連動制御のため）
        for (const lid of layer_ids) {
            if (!this.state.layerParent[lid]) {
                this.state.layerParent[lid] = cgId;
            }
        }

        if (this._selectedCgId) {
            // 選択中CGのサブグループとして追加（cgOrderには追加しない）
            const parentCg = this.state.customGroups.find(g => g.id === this._selectedCgId);
            if (parentCg) parentCg.layer_ids.push(cgId);
        } else {
            // ルートCGとして cgOrder の先頭に追加
            this.state.cgOrder.unshift(cgId);
        }
        this.selectedIds.clear();
        this._selectedCgId = cgId;
        this._renderTree();
    }

    _ungroup() {
        if (!this.state.customGroups.length) { alert(t("noCustomGroupToRemove")); return; }
        let targetId = this._selectedCgId;
        if (!targetId) {
            const allIds = new Set(this.state.customGroups.map(g => g.id));
            const childIds = new Set();
            for (const cg of this.state.customGroups) {
                for (const lid of cg.layer_ids) if (allIds.has(lid)) childIds.add(lid);
            }
            const rootCgs = this.state.customGroups.filter(cg => !childIds.has(cg.id));
            if (!rootCgs.length) return;
            targetId = rootCgs[rootCgs.length - 1].id;
        }
        const idx = this.state.customGroups.findIndex(g => g.id === targetId);
        if (idx === -1) return;

        const targetCg = this.state.customGroups[idx];
        const cgOrderIdx = this.state.cgOrder.indexOf(targetId);

        // 子CG をターゲットの位置に挿入（ルートCGになる）
        const childCgIds = targetCg.layer_ids.filter(lid => lid.startsWith('cg_'));
        for (const childId of [...childCgIds].reverse()) {
            if (!this.state.cgOrder.includes(childId)) {
                const insertAt = cgOrderIdx !== -1 ? cgOrderIdx : 0;
                this.state.cgOrder.splice(insertAt, 0, childId);
            }
        }

        // cgOrder からターゲットを削除
        const oi = this.state.cgOrder.indexOf(targetId);
        if (oi !== -1) this.state.cgOrder.splice(oi, 1);

        // 親グループの layer_ids からも削除
        for (const g of this.state.customGroups) g.layer_ids = g.layer_ids.filter(id => id !== targetId);

        // グループのリグポイントを削除し、layer_parent をクリア
        delete this.state.rigging[targetId];
        delete this.state.pose[targetId];
        for (const lid of targetCg.layer_ids) {
            if (this.state.layerParent[lid] === targetId) delete this.state.layerParent[lid];
        }

        this.state.customGroups.splice(idx, 1);
        this._selectedCgId = null;
        this._renderTree();
    }

    _indent() {
        const selId = this._selectedCgId || [...this.selectedIds][0];
        if (!selId) return;
        if (this._activeTab === 'parent') { this._indentParent(selId); return; }

        // レイヤータブ: cgOrder / CG内の直前アイテムを親にする
        const cgMap = {};
        for (const cg of this.state.customGroups) cgMap[cg.id] = cg;
        const itemParent = {};
        for (const cg of this.state.customGroups) {
            for (const lid of cg.layer_ids) itemParent[lid] = cg.id;
        }
        const lp = this.state.layerParent;
        const parentCgId = itemParent[selId];
        let prevId;
        if (!parentCgId) {
            const idx = this.state.cgOrder.indexOf(selId);
            if (idx <= 0) return;
            prevId = this.state.cgOrder[idx - 1];
        } else {
            const parentCg = cgMap[parentCgId];
            if (!parentCg) return;
            const displayOrder = [];
            const addWithChildren = lid => {
                displayOrder.push(lid);
                parentCg.layer_ids.filter(c => lp[c] === lid && !cgMap[c]).forEach(addWithChildren);
            };
            parentCg.layer_ids
                .filter(lid => !parentCg.layer_ids.includes(lp[lid]) || cgMap[lid])
                .forEach(lid => cgMap[lid] ? displayOrder.push(lid) : addWithChildren(lid));
            const idx = displayOrder.indexOf(selId);
            if (idx <= 0) return;
            prevId = displayOrder[idx - 1];
        }
        if (!prevId || cgMap[prevId]) return;
        if (lp[selId] === prevId) return;
        lp[selId] = prevId;
        this._renderTree();
    }

    _indentParent(selId) {
        const lp = this.state.layerParent;
        const parentId = lp[selId] || null;
        const siblings = parentId === null ? this._ptGetRoots() : this._ptGetChildren(parentId);
        const idx = siblings.indexOf(selId);
        if (idx <= 0) return;
        const prevId = siblings[idx - 1];
        if (!prevId || lp[selId] === prevId) return;

        // parentTabOrder を更新: 旧親から取り出し、新親の子に追加
        if (parentId === null) {
            const roots = this._ptGetRoots();
            const ri = roots.indexOf(selId);
            if (ri !== -1) roots.splice(ri, 1);
            this.state.parentTabOrder.roots = roots;
        } else {
            const ch = this._ptGetChildren(parentId);
            const ci = ch.indexOf(selId);
            if (ci !== -1) ch.splice(ci, 1);
            this.state.parentTabOrder.children[parentId] = ch;
        }
        const newCh = this._ptGetChildren(prevId);
        if (!newCh.includes(selId)) newCh.push(selId);
        this.state.parentTabOrder.children[prevId] = newCh;

        lp[selId] = prevId;
        this._renderTree();
    }

    _outdent() {
        const selId = this._selectedCgId || [...this.selectedIds][0];
        if (!selId) return;
        if (this._activeTab === 'parent' && !selId.startsWith('cg_')) { this._outdentParent(selId); return; }

        // レイヤータブ: CGネスト or layerParent削除
        const cgMap = {};
        for (const cg of this.state.customGroups) cgMap[cg.id] = cg;
        const itemParent = {};
        for (const cg of this.state.customGroups) {
            for (const lid of cg.layer_ids) itemParent[lid] = cg.id;
        }
        const lp = this.state.layerParent;
        if (selId.startsWith('cg_')) {
            const parentCgId = itemParent[selId];
            if (!parentCgId) return;
            const parentCg = cgMap[parentCgId];
            const itemIdx = parentCg.layer_ids.indexOf(selId);
            parentCg.layer_ids.splice(itemIdx, 1);
            const grandParentCgId = itemParent[parentCgId];
            if (!grandParentCgId) {
                if (!this.state.cgOrder.includes(selId)) {
                    const pIdx = this.state.cgOrder.indexOf(parentCgId);
                    this.state.cgOrder.splice(pIdx !== -1 ? pIdx + 1 : this.state.cgOrder.length, 0, selId);
                }
            } else {
                const grandParentCg = cgMap[grandParentCgId];
                const pIdx = grandParentCg.layer_ids.indexOf(parentCgId);
                grandParentCg.layer_ids.splice(pIdx + 1, 0, selId);
            }
        } else {
            if (!lp[selId]) return;
            delete lp[selId];
        }
        this._renderTree();
    }

    _outdentParent(selId) {
        const lp = this.state.layerParent;
        if (!lp[selId]) return;
        const parentId = lp[selId];

        // parentTabOrder 更新: 親の子リストから取り出し、ルートに挿入
        const ch = this._ptGetChildren(parentId);
        const ci = ch.indexOf(selId);
        if (ci !== -1) ch.splice(ci, 1);
        this.state.parentTabOrder.children[parentId] = ch;

        const roots = this._ptGetRoots();
        if (!roots.includes(selId)) {
            const pi = roots.indexOf(parentId);
            roots.splice(pi !== -1 ? pi + 1 : roots.length, 0, selId);
        }
        this.state.parentTabOrder.roots = roots;

        delete lp[selId];
        this._renderTree();
    }

    // ペアレントタブ ▲▼ ボタン: 兄弟間での順序変更（cgOrderに影響しない）
    _shiftParentTabItem(dir) {
        const selId = [...this.selectedIds][0];
        if (!selId) return;
        const lp = this.state.layerParent;
        const parentId = lp[selId] || null;
        const siblings = parentId === null ? this._ptGetRoots() : this._ptGetChildren(parentId);
        const idx = siblings.indexOf(selId);
        if (idx === -1) return;
        if (dir === -1 && idx === 0) return;
        if (dir ===  1 && idx === siblings.length - 1) return;
        [siblings[idx], siblings[idx + dir]] = [siblings[idx + dir], siblings[idx]];
        if (parentId === null) this.state.parentTabOrder.roots = siblings;
        else this.state.parentTabOrder.children[parentId] = siblings;
        this._renderTree();
    }

    // parentTabOrder のルート一覧（なければ cgOrder から派生）
    _ptGetRoots() {
        const pto = this.state.parentTabOrder;
        if (pto.roots) return [...pto.roots];
        return this._ptDeriveRoots();
    }

    // parentTabOrder の子一覧（なければ cgOrder 順から派生）
    _ptGetChildren(parentId) {
        const pto = this.state.parentTabOrder;
        if (pto.children[parentId]) return [...pto.children[parentId]];
        return this._ptDeriveChildren(parentId);
    }

    _ptDeriveRoots() {
        const lp = this.state.layerParent;
        const cgIds = new Set(this.state.customGroups.map(cg => cg.id));
        return this._ptAllOrderedIds().filter(id => !lp[id] || cgIds.has(lp[id]));
    }

    _ptDeriveChildren(parentId) {
        const lp = this.state.layerParent;
        const cgIds = new Set(this.state.customGroups.map(cg => cg.id));
        if (cgIds.has(parentId)) return [];
        return this._ptAllOrderedIds().filter(id => lp[id] === parentId);
    }

    // PSDレイヤーツリー順の全レイヤーIDリスト（CG構造を完全無視）
    _ptAllOrderedIds() {
        const result = [];
        const collect = nodes => {
            for (const n of [...nodes].reverse()) {
                result.push(n.id);
                if (n.children) collect(n.children);
            }
        };
        collect(this.layerTree);
        return result;
    }

    _apply() {
        const configObj = this.state.toConfig();

        function buildOrder(nodes) {
            return nodes.map(n => {
                const entry = { id: n.id };
                if (n.children) entry.children = buildOrder(n.children);
                return entry;
            });
        }
        configObj.layer_order = buildOrder(this.layerTree);

        const w = findWidget(this.node, "layer_config");
        if (w) {
            // キーフレームデータを既存 config から引き継ぐ
            let existing = {};
            try { existing = JSON.parse(w.value || "{}"); } catch (_) {}
            if (existing.keyframes?.length)              configObj.keyframes       = existing.keyframes;
            if (existing.kf_total_frames !== undefined)  configObj.kf_total_frames = existing.kf_total_frames;
            if (existing.kf_fps !== undefined)           configObj.kf_fps          = existing.kf_fps;
            w.value = JSON.stringify(configObj);
        }

        const node = this.node;
        node._psdLayers = JSON.parse(JSON.stringify(this.layerTree));

        // ノード内プレビューを更新
        if (node._layerImages && node._psdW && node._psdH) {
            drawNodeCanvas(node);
        } else {
            _setNodePreview(node, configObj);
        }

        this.destroy();
    }

    async _saveConfig() {
        const name = prompt(t("promptModelName"));
        if (!name || !name.trim()) return;
        const configObj = this.state.toConfig();
        const buildOrder = nodes => nodes.map(n => {
            const e = { id: n.id };
            if (n.children) e.children = buildOrder(n.children);
            return e;
        });
        configObj.layer_order = buildOrder(this.layerTree);
        const psdFilename = this.node._psdFilename || findWidget(this.node, "psd_filename")?.value || "";
        const content = { psd_filename: psdFilename, layer_config: configObj };
        const node = this.node;
        if (node._nodeCanvas) {
            content.thumbnail = captureThumbFromNode(node, 140, 140);
        }
        try {
            const res = await fetch("/psd_loader/library/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: name.trim(), content }),
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
        } catch (e) { alert(t("modelSaveFailed", e.message)); }
    }

    async _savePoseFromModal() {
        const name = prompt(t("promptPoseName"));
        if (!name || !name.trim()) return;
        const config = this.state.toConfig();
        const content = {
            visibility: JSON.parse(JSON.stringify(config.visibility || {})),
            pose:       JSON.parse(JSON.stringify(config.pose       || {})),
            thumbnail:  null,
        };
        const node = this.node;
        {
            const savedCam   = { ...this._previewCam };
            const wasShowing = this._showRigLabels;
            this._previewCam    = { ...this._defaultPreviewCam };
            this._showRigLabels = false;
            this._drawPreview();
            const mof = this._computeModalOutputFrame();
            if (mof && mof.sw > 0 && mof.sh > 0) {
                const thumbW = 140;
                const thumbH = Math.max(1, Math.round(thumbW * mof.sh / mof.sw));
                const tc = document.createElement("canvas"); tc.width = thumbW; tc.height = thumbH;
                tc.getContext("2d").drawImage(this._previewCanvas, mof.sx, mof.sy, mof.sw, mof.sh, 0, 0, thumbW, thumbH);
                content.thumbnail = tc.toDataURL("image/png");
            } else if (node._nodeCanvas) {
                content.thumbnail = captureThumbFromNode(node, 140);
            }
            this._previewCam    = savedCam;
            this._showRigLabels = wasShowing;
            this._drawPreview();
        }
        try {
            const res = await fetch("/psd_loader/library/poses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: name.trim(), content }),
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
        } catch (e) { alert(t("poseSaveFailed", e.message)); }
    }

    async _savePoseWithSwFromModal() {
        const name = prompt(t("promptPoseNameWithSw"));
        if (!name || !name.trim()) return;
        const config = this.state.toConfig();
        const swAngles = {};
        (config.sw_layers || []).forEach(swl => {
            (swl.points || []).forEach(pt => { swAngles[pt.id] = pt.angle ?? 0; });
        });
        const content = {
            visibility: JSON.parse(JSON.stringify(config.visibility || {})),
            pose:       JSON.parse(JSON.stringify(config.pose       || {})),
            sw_angles:  swAngles,
            thumbnail:  null,
        };
        const node = this.node;
        {
            const savedCam   = { ...this._previewCam };
            const wasShowing = this._showRigLabels;
            this._previewCam    = { ...this._defaultPreviewCam };
            this._showRigLabels = false;
            this._drawPreview();
            const mof = this._computeModalOutputFrame();
            if (mof && mof.sw > 0 && mof.sh > 0) {
                const thumbW = 140;
                const thumbH = Math.max(1, Math.round(thumbW * mof.sh / mof.sw));
                const tc = document.createElement("canvas"); tc.width = thumbW; tc.height = thumbH;
                tc.getContext("2d").drawImage(this._previewCanvas, mof.sx, mof.sy, mof.sw, mof.sh, 0, 0, thumbW, thumbH);
                content.thumbnail = tc.toDataURL("image/png");
            } else if (node._nodeCanvas) {
                content.thumbnail = captureThumbFromNode(node, 140);
            }
            this._previewCam    = savedCam;
            this._showRigLabels = wasShowing;
            this._drawPreview();
        }
        try {
            const res = await fetch("/psd_loader/library/poses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: name.trim(), content }),
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
        } catch (e) { alert(t("poseSaveFailed", e.message)); }
    }

    async _reloadFromNode() {
        const layers = this.node._psdLayers || [];
        let config = {};
        try { config = JSON.parse(findWidget(this.node, "layer_config")?.value || "{}"); } catch (_) {}
        this.layerTree     = JSON.parse(JSON.stringify(layers));
        this.state         = LayerState.fromConfig(this.layerTree, config);
        this.selectedIds   = new Set();
        this.collapsedIds  = new Set();
        this._selectedCgId = null;
        if (config.rigging && Object.keys(config.rigging).length > 0 && this._rigMode === 'normal') {
            this._rigMode = 'pose';
            this._updateRigModeUI(this._setupBar);
        }
        this._renderTree();
        await this._initPreview();
    }

    destroy() {
        this._overlay?.remove();
        this._overlay = null;
    }
}

// ================================================
// モーダルを開く
// ================================================
async function openLayerModal(node) {
    let layers = node._psdLayers;
    const filename = node._psdFilename || findWidget(node, "psd_filename")?.value;

    if (!layers && filename) {
        try {
            const res  = await fetch(`/psd_loader/layers?filename=${encodeURIComponent(filename)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            layers = data.layers; node._psdLayers = layers; node._psdW = data.width; node._psdH = data.height;
        } catch (err) {
            alert(t("layerFetchFailed", err.message));
            // PSDが見つからなくてもモーダルは開く（新PC移行時など）
        }
    }

    let existingConfig = {};
    try { existingConfig = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}

    new PSDModal(node, layers || [], existingConfig);
}

// ================================================
// ライブラリモーダル
// ================================================
class LibraryModal {
    constructor(node) {
        this.node = node;
        this._models = [];
        this._poses  = [];
        this._dom    = null;
        this._modelFilter  = "";
        this._poseFilter   = "";
        this._poseThumbSize = "M";   // S / M / L
        this._selectedModel = null;
        this._selectedItem  = null;  // 現在ハイライト中のリストアイテム要素
    }

    async open() {
        this._dom = this._buildDOM();
        document.body.appendChild(this._dom);
        await this._loadData();
    }

    _buildDOM() {
        const S = (el, css) => { el.style.cssText = css; return el; };

        const overlay = document.createElement("div");
        S(overlay, "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;");
        overlay.addEventListener("click", e => { if (e.target === overlay) this.destroy(); });

        const container = document.createElement("div");
        S(container, "background:#252535;border-radius:8px;width:720px;height:540px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.7);");

        // header
        const header = document.createElement("div");
        S(header, "display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #3d3d55;flex-shrink:0;");
        const titleEl = Object.assign(document.createElement("span"), { textContent: "Library" });
        S(titleEl, "font-size:14px;font-weight:bold;color:#dde;");
        const closeBtn = Object.assign(document.createElement("button"), { textContent: "×" });
        S(closeBtn, "background:none;border:none;color:#999;font-size:20px;cursor:pointer;line-height:1;padding:0 4px;");
        closeBtn.onclick = () => this.destroy();
        header.append(titleEl, closeBtn);

        // body
        const body = document.createElement("div");
        S(body, "display:flex;flex:1;overflow:hidden;min-height:0;");

        // --- left panel (model list + thumbnail) ---
        const leftPanel = document.createElement("div");
        S(leftPanel, "width:155px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #3d3d55;");

        const leftTop = document.createElement("div");
        S(leftTop, "padding:6px 8px;border-bottom:1px solid #3d3d55;flex-shrink:0;");
        const modelSearch = Object.assign(document.createElement("input"), { type: "text", placeholder: "psdmodel" });
        S(modelSearch, "width:100%;box-sizing:border-box;background:#1a1a2a;border:1px solid #4a4a66;color:#dde;padding:4px 6px;border-radius:4px;font-size:11px;outline:none;");
        modelSearch.addEventListener("input", () => { this._modelFilter = modelSearch.value.toLowerCase(); this._renderModels(); });
        leftTop.appendChild(modelSearch);

        this._modelListEl = document.createElement("div");
        S(this._modelListEl, "flex:1;overflow-y:auto;padding:4px;display:flex;flex-direction:column;gap:1px;min-height:0;");

        // 選択モデルサムネイル（左パネル下部）
        this._modelThumbEl = document.createElement("div");
        S(this._modelThumbEl, "flex-shrink:0;height:106px;border-top:1px solid #3d3d55;display:flex;align-items:center;justify-content:center;background:#1a1a2a;overflow:hidden;");
        const thumbPlaceholder = Object.assign(document.createElement("span"), { textContent: t("selectModel") });
        S(thumbPlaceholder, "font-size:10px;color:#444;");
        this._modelThumbEl.appendChild(thumbPlaceholder);

        leftPanel.append(leftTop, this._modelListEl, this._modelThumbEl);

        // --- right panel (pose grid) ---
        const rightPanel = document.createElement("div");
        S(rightPanel, "flex:1;display:flex;flex-direction:column;overflow:hidden;");

        const rightTop = document.createElement("div");
        S(rightTop, "display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #3d3d55;flex-shrink:0;");

        const poseSearch = Object.assign(document.createElement("input"), { type: "text", placeholder: t("poseSearchPlaceholder") });
        S(poseSearch, "flex:1;background:#1a1a2a;border:1px solid #4a4a66;color:#dde;padding:4px 6px;border-radius:4px;font-size:11px;outline:none;");
        poseSearch.addEventListener("input", () => { this._poseFilter = poseSearch.value.toLowerCase(); this._renderPoses(); });

        // S/M/L サイズ切り替えボタン
        const sizeGroup = document.createElement("div");
        S(sizeGroup, "display:flex;gap:2px;flex-shrink:0;");
        ["S", "M", "L"].forEach(sz => {
            const btn = Object.assign(document.createElement("button"), { textContent: sz });
            S(btn, `background:${sz === this._poseThumbSize ? "#4a4a88" : "#2a2a44"};border:1px solid #4a4a66;color:#ccd;padding:3px 7px;border-radius:3px;cursor:pointer;font-size:11px;`);
            btn.dataset.sz = sz;
            btn.addEventListener("click", () => {
                this._poseThumbSize = sz;
                sizeGroup.querySelectorAll("button").forEach(b => {
                    b.style.background = b.dataset.sz === sz ? "#4a4a88" : "#2a2a44";
                });
                this._renderPoses();
            });
            sizeGroup.appendChild(btn);
        });

        rightTop.append(poseSearch, sizeGroup);

        this._poseGridEl = document.createElement("div");
        S(this._poseGridEl, "flex:1;overflow-y:auto;padding:8px;align-content:start;");
        this._updateGridCss();

        rightPanel.append(rightTop, this._poseGridEl);
        body.append(leftPanel, rightPanel);

        container.append(header, body);
        overlay.appendChild(container);
        return overlay;
    }

    _thumbPx() { return { S: 76, M: 110, L: 160 }[this._poseThumbSize] ?? 110; }

    _updateGridCss() {
        const px = this._thumbPx();
        this._poseGridEl.style.cssText = `flex:1;overflow-y:auto;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(${px}px,1fr));gap:6px;align-content:start;`;
    }

    async _loadData() {
        this._modelListEl.textContent = t("loading");
        this._poseGridEl.textContent  = t("loading");
        try {
            const [mr, pr] = await Promise.all([
                fetch("/psd_loader/library/models"),
                fetch("/psd_loader/library/poses"),
            ]);
            this._models = await mr.json();
            this._poses  = await pr.json();
        } catch (_) {
            this._models = []; this._poses = [];
        }
        this._renderModels();
        this._renderPoses();
    }

    _renderModels() {
        const q    = this._modelFilter;
        const list = q ? this._models.filter(m => m.name.toLowerCase().includes(q)) : this._models;
        this._modelListEl.innerHTML = "";
        this._selectedItem = null;
        if (!list.length) {
            const e = Object.assign(document.createElement("div"), { textContent: t("noSavedModels") });
            e.style.cssText = "color:#555;font-size:11px;padding:10px;text-align:center;";
            this._modelListEl.appendChild(e);
            return;
        }
        list.forEach(m => {
            const item = document.createElement("div");
            const isSel = this._selectedModel?.filename === m.filename;
            item.style.cssText = `padding:5px 7px;border-radius:4px;cursor:pointer;color:#ccd;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;background:${isSel ? "#3a3a60" : ""};`;
            item.textContent = m.name;
            item.title = m.psd_filename ? `PSD: ${m.psd_filename}` : m.name;
            if (isSel) this._selectedItem = item;
            item.addEventListener("mouseover", () => { if (this._selectedModel?.filename !== m.filename) item.style.background = "#2d2d4a"; });
            item.addEventListener("mouseout",  () => { if (this._selectedModel?.filename !== m.filename) item.style.background = ""; });
            item.addEventListener("click",       () => this._selectModel(m, item));
            item.addEventListener("dblclick",    () => this._loadModel(m));
            item.addEventListener("contextmenu", e => { e.preventDefault(); this._deleteModel(m); });
            this._modelListEl.appendChild(item);
        });
    }

    _selectModel(m, itemEl) {
        if (this._selectedItem) {
            this._selectedItem.style.background = "";
        }
        this._selectedModel = m;
        this._selectedItem  = itemEl;
        if (itemEl) itemEl.style.background = "#3a3a60";

        this._modelThumbEl.innerHTML = "";
        if (m.thumbnail) {
            const img = document.createElement("img");
            img.src = m.thumbnail;
            img.style.cssText = "max-width:100%;max-height:100%;width:auto;height:auto;";
            this._modelThumbEl.appendChild(img);
        } else {
            const ph = Object.assign(document.createElement("span"), { textContent: t("noThumbnail") });
            ph.style.cssText = "font-size:10px;color:#444;";
            this._modelThumbEl.appendChild(ph);
        }
    }

    _renderPoses() {
        const q    = this._poseFilter;
        const list = q ? this._poses.filter(p => p.name.toLowerCase().includes(q)) : this._poses;
        this._updateGridCss();
        this._poseGridEl.innerHTML = "";
        const px = this._thumbPx();
        if (!list.length) {
            const e = Object.assign(document.createElement("div"), { textContent: t("noSavedPoses") });
            e.style.cssText = "color:#555;font-size:11px;padding:16px;text-align:center;grid-column:1/-1;";
            this._poseGridEl.appendChild(e);
            return;
        }
        list.forEach(p => {
            const card = document.createElement("div");
            card.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;border-radius:5px;padding:3px;border:2px solid transparent;";
            card.addEventListener("mouseover", () => card.style.borderColor = "#5a5a8a");
            card.addEventListener("mouseout",  () => card.style.borderColor = "transparent");
            card.addEventListener("click",       () => this._loadPose(p));
            card.addEventListener("contextmenu", e => { e.preventDefault(); this._deletePose(p); });

            // サムネイルボックス（正方形、object-fit:contain で縦横比を保持）
            const thumbBox = document.createElement("div");
            thumbBox.style.cssText = `width:${px}px;height:${px}px;background:#1a1a2a;border-radius:3px;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;`;
            if (p.thumbnail) {
                const img = document.createElement("img");
                img.src = p.thumbnail;
                img.style.cssText = `max-width:${px}px;max-height:${px}px;width:auto;height:auto;`;
                thumbBox.appendChild(img);
            } else {
                thumbBox.textContent = "🧍";
                thumbBox.style.fontSize = `${Math.round(px * 0.32)}px`;
                thumbBox.style.color = "#333";
            }

            const label = Object.assign(document.createElement("div"), { textContent: p.name });
            label.style.cssText = "font-size:10px;color:#aab;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            card.append(thumbBox, label);
            this._poseGridEl.appendChild(card);
        });
    }

    async _loadModel(m) {
        try {
            const res  = await fetch(`/psd_loader/library/models/${encodeURIComponent(m.filename)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const node = this.node;
            if (data.layer_config) {
                const lw = findWidget(node, "layer_config");
                if (lw) lw.value = JSON.stringify(data.layer_config);
            }
            if (data.psd_filename) {
                const fw = findWidget(node, "psd_filename");
                if (fw) fw.value = data.psd_filename;
                node._psdFilename = data.psd_filename;
                if (node._psdBtn) node._psdBtn.textContent = `📂 ${data.psd_filename}`;
                try {
                    const lr = await fetch(`/psd_loader/layers?filename=${encodeURIComponent(data.psd_filename)}`);
                    const ld = await lr.json();
                    if (!ld.error) {
                        node._psdLayers = ld.layers; node._psdW = ld.width; node._psdH = ld.height;
                        node._layerImages = await loadLayerImages(data.psd_filename, ld.layers);
                        setDefaultCamera(node);
                        drawNodeCanvas(node);
                    }
                } catch (_) {}
            }
            this.destroy();
        } catch (e) { alert(t("modelLoadFailed", e.message)); }
    }

    async _loadPose(p) {
        try {
            const res  = await fetch(`/psd_loader/library/poses/${encodeURIComponent(p.filename)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const node = this.node;
            let config = {};
            try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}

            if (data._type === "kf_project" && Array.isArray(data.keyframes)) {
                // ---- キーフレームプロジェクトの復元 ----
                node._keyframes = JSON.parse(JSON.stringify(data.keyframes));
                if (data.kf_total_frames !== undefined) {
                    node._kfTotalFrames = data.kf_total_frames;
                    if (node._kfTotalFramesEl) node._kfTotalFramesEl.value = data.kf_total_frames;
                }
                if (data.kf_fps !== undefined) {
                    node._kfFps = data.kf_fps;
                    if (node._kfFpsEl) node._kfFpsEl.value = data.kf_fps;
                }
                // layer_config に永続化
                config.keyframes       = JSON.parse(JSON.stringify(node._keyframes));
                config.kf_total_frames = node._kfTotalFrames;
                config.kf_fps          = node._kfFps;
                const w = findWidget(node, "layer_config");
                if (w) w.value = JSON.stringify(config);
                updateTimelineCanvas(node);
                seekToFrame(node, 0);   // フレーム0にシーク（ポーズも適用される）
            } else {
                // ---- 通常ポーズの復元 ----
                if (data.visibility) config.visibility = JSON.parse(JSON.stringify(data.visibility));
                if (data.pose)       config.pose       = JSON.parse(JSON.stringify(data.pose));
                if (data.sw_angles && config.sw_layers) {
                    config.sw_layers.forEach(swl => {
                        (swl.points || []).forEach(pt => {
                            if (data.sw_angles[pt.id] !== undefined) pt.angle = data.sw_angles[pt.id];
                        });
                    });
                }
                const w = findWidget(node, "layer_config");
                if (w) w.value = JSON.stringify(config);
                drawNodeCanvas(node);
            }

            this.destroy();
        } catch (e) { alert(t("poseLoadFailed", e.message)); }
    }

    async _deleteModel(m) {
        if (!confirm(t("confirmDeleteModel", m.name))) return;
        await fetch(`/psd_loader/library/models/${encodeURIComponent(m.filename)}`, { method: "DELETE" });
        if (this._selectedModel?.filename === m.filename) {
            this._selectedModel = null;
            this._selectedItem  = null;
            this._modelThumbEl.innerHTML = "";
            const ph = Object.assign(document.createElement("span"), { textContent: t("selectModel") });
            ph.style.cssText = "font-size:10px;color:#444;";
            this._modelThumbEl.appendChild(ph);
        }
        await this._loadData();
    }

    async _deletePose(p) {
        if (!confirm(t("confirmDeletePose", p.name))) return;
        await fetch(`/psd_loader/library/poses/${encodeURIComponent(p.filename)}`, { method: "DELETE" });
        await this._loadData();
    }

    destroy() {
        this._dom?.remove();
        this._dom = null;
    }
}

// ================================================
// プレビューキャンバスのマウス操作（パン・ズーム）
// ================================================
function setupPreviewInteraction(canvas, node) {
    let isPanning  = false;
    let isRolling  = false;
    let isRigDrag  = false;
    let rigDragInfo = null;
    let lastMX = 0, lastMY = 0;
    let rollStartX = 0, rollStartRoll = 0;

    // キャンバスピクセル座標 → PSD（ワールド）座標
    const toWorld = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        const sx = (clientX - rect.left) * (canvas.width  / rect.width);
        const sy = (clientY - rect.top)  * (canvas.height / rect.height);
        const cam = node._camera;
        const W = canvas.width, H = canvas.height;
        const rx = sx - W / 2;
        const ry = sy - H / 2;
        const roll = cam.roll || 0;
        const cos = Math.cos(-roll), sin = Math.sin(-roll);
        const rrx = rx * cos - ry * sin;
        const rry = rx * sin + ry * cos;
        return {
            x: rrx / cam.zoom + W / 2 - cam.x,
            y: rry / cam.zoom + H / 2 - cam.y,
        };
    };

    canvas.addEventListener("mousedown", e => {
        lastMX = e.clientX;
        lastMY = e.clientY;
        e.preventDefault();

        // Alt+右ドラッグ → カメラロール
        if (e.altKey && e.button === 2) {
            isRolling = true;
            rollStartX = e.clientX;
            rollStartRoll = node._camera.roll || 0;
            canvas.style.cursor = "ew-resize";
            return;
        }

        // リグポイント・SWポイントのヒットテスト
        if (node._layerImages && node._psdLayers) {
            let config = {};
            try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}
            if (config.rigging || config.sw_layers?.length) {
                const cam = node._camera;
                const { x: wx, y: wy } = toWorld(e.clientX, e.clientY);
                const imgMap = getEffectiveImageMap(node, config);
                const hit = hitTestRig(wx, wy, node._psdLayers, imgMap,
                                       config.rigging || {}, config.pose, 'pose', cam.zoom,
                                       config.layer_parent || {}, config.custom_groups || [], node._rigPointSize ?? 1.0, config.sw_layers || []);
                if (hit && (e.altKey || e.ctrlKey) && (hit.type === 'r' || hit.type === 'mr')) {
                    if (!config.pose) config.pose = {};
                    if (!config.pose[hit.layerId]) config.pose[hit.layerId] = { angle: 0, tx: 0, ty: 0 };
                    const p = config.pose[hit.layerId];
                    if (e.altKey)  p.flipX = !p.flipX;
                    if (e.ctrlKey) p.flipY = !p.flipY;
                    const w = findWidget(node, "layer_config");
                    if (w) w.value = JSON.stringify(config);
                    drawNodeCanvas(node);
                    return;
                }
                if (hit && hit.type === 'sw_handle') {
                    isRigDrag = true;
                    const swLayer = (config.sw_layers || []).find(l => l.id === hit.swLayerId);
                    const swInfo = swLayer?.points?.find(p => p.id === hit.swPointId);
                    if (swInfo) {
                        rigDragInfo = { hit, config,
                                        pivotX: swInfo.x ?? 0,
                                        pivotY: swInfo.y ?? 0 };
                        node._selectedSwPointInfo = { swLayerId: hit.swLayerId, pointId: hit.swPointId };
                        canvas.style.cursor = "crosshair";
                        return;
                    }
                }
                if (hit && hit.layerId) {
                    isRigDrag = true;
                    const rig = config.rigging[hit.layerId];
                    const entry = imgMap[hit.layerId];
                    const pose = config.pose?.[hit.layerId] || { angle: 0, tx: 0, ty: 0 };
                    let pivotX = 0, pivotY = 0, initAngle = 0;
                    const chain = buildAncestorChain(hit.layerId, config.layer_parent || {},
                                                     config.rigging, config.pose, imgMap);
                    if (hit.type === 'r' && rig.r) {
                        const local = { x: entry.left + rig.r.x + (pose.tx ?? 0), y: entry.top + rig.r.y + (pose.ty ?? 0) };
                        const vis = chain.length > 0 ? applyChainToPoint(local.x, local.y, chain) : local;
                        pivotX = vis.x; pivotY = vis.y;
                        initAngle = Math.atan2(wy - pivotY, wx - pivotX);
                    } else if (hit.type === 'mr' && rig.mr) {
                        const local = { x: entry.left + rig.mr.x, y: entry.top + rig.mr.y };
                        const vis = chain.length > 0 ? applyChainToPoint(local.x, local.y, chain) : local;
                        pivotX = vis.x; pivotY = vis.y;
                        initAngle = Math.atan2(wy - pivotY, wx - pivotX);
                    }
                    rigDragInfo = { hit, config, pivotX, pivotY,
                                    initAngle, startAngle: pose.angle ?? 0,
                                    startTx: pose.tx ?? 0, startTy: pose.ty ?? 0, chain };
                    node._rigSelectedLayerId = hit.layerId;
                    canvas.style.cursor = "crosshair";
                    return;
                }
            }
        }

        isPanning = true;
        canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("mousemove", e => {
        if (isRolling) {
            const dx = e.clientX - rollStartX;
            node._camera.roll = rollStartRoll + dx * 0.005;
            drawNodeCanvas(node);
            return;
        }

        if (isRigDrag && rigDragInfo) {
            const { x: wx, y: wy } = toWorld(e.clientX, e.clientY);
            const { hit, config, pivotX, pivotY, initAngle, startAngle, startTx, startTy } = rigDragInfo;
            const layerId = hit.layerId;
            const rig   = (config.rigging || {})[layerId];
            const entry = getEffectiveImageMap(node, config)[layerId];

            if (!config.pose) config.pose = {};
            if (!config.pose[layerId]) config.pose[layerId] = { angle: 0, tx: 0, ty: 0 };
            const p = config.pose[layerId];

            if (hit.type === 'sw_handle') {
                // SWハンドルの角度変更
                const swLayer = (config.sw_layers || []).find(l => l.id === hit.swLayerId);
                const swInfo = swLayer?.points?.find(p => p.id === hit.swPointId);
                if (swInfo) swInfo.angle = Math.atan2(wy - rigDragInfo.pivotY, wx - rigDragInfo.pivotX);
            } else if (hit.type === 'r' || hit.type === 'mr') {
                const curAngle = Math.atan2(wy - pivotY, wx - pivotX);
                p.angle = startAngle + (curAngle - initAngle);
            } else if (hit.type === 'orange') {
                const rawSX = entry.left + rig.mr.x;
                const rawSY = entry.top  + rig.mr.y;
                const chain = rigDragInfo.chain || [];
                let localWx = wx, localWy = wy;
                if (chain.length > 0) {
                    const inv = inverseChainToPoint(wx, wy, chain);
                    localWx = inv.x; localWy = inv.y;
                }
                let newTx = localWx - rawSX;
                let newTy = localWy - rawSY;
                if (rig.mr_radius > 0) {
                    const dist = Math.hypot(newTx, newTy);
                    if (dist > rig.mr_radius) {
                        newTx = newTx / dist * rig.mr_radius;
                        newTy = newTy / dist * rig.mr_radius;
                    }
                }
                p.tx = newTx; p.ty = newTy;
            }

            // layer_config ウィジェットを更新して再描画
            const w = findWidget(node, "layer_config");
            if (w) w.value = JSON.stringify(config);
            drawNodeCanvas(node);
            return;
        }

        if (!isPanning) return;
        const rect   = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        const cam    = node._camera;
        cam.x += (e.clientX - lastMX) * scaleX / cam.zoom;
        cam.y += (e.clientY - lastMY) * scaleY / cam.zoom;
        lastMX = e.clientX;
        lastMY = e.clientY;
        drawNodeCanvas(node);
    });

    canvas.addEventListener("mouseup", () => {
        isPanning = false; isRolling = false; isRigDrag = false; rigDragInfo = null;
        canvas.style.cursor = "grab";
    });
    canvas.addEventListener("mouseleave", () => {
        isPanning = false; isRolling = false; isRigDrag = false; rigDragInfo = null;
        canvas.style.cursor = "grab";
    });

    // ズーム（カーソル位置中心）
    canvas.addEventListener("wheel", e => {
        e.preventDefault();
        const cam     = node._camera;
        const oldZoom = cam.zoom;
        const factor  = 1.12;
        cam.zoom = e.deltaY < 0
            ? Math.min(20.0, cam.zoom * factor)
            : Math.max(0.05, cam.zoom / factor);

        const rect = canvas.getBoundingClientRect();
        const cvsX = (e.clientX - rect.left) * (canvas.width  / rect.width);
        const cvsY = (e.clientY - rect.top)  * (canvas.height / rect.height);
        const W = canvas.width, H = canvas.height;
        cam.x += (cvsX - W / 2) * (1 / cam.zoom - 1 / oldZoom);
        cam.y += (cvsY - H / 2) * (1 / cam.zoom - 1 / oldZoom);

        drawNodeCanvas(node);
    }, { passive: false });

    canvas.addEventListener("contextmenu", e => e.preventDefault());
}

// ================================================
// プレビューエリア固定サイズ定数
// ================================================
const MODAL_CANVAS_W   = 366;   // モーダルプレビューキャンバス内部解像度（パネル幅390 - padding*2）
const MODAL_CANVAS_H   = 520;   // モーダルプレビューキャンバス内部解像度

const PREVIEW_IMG_H    = 422;
const PREVIEW_NODE_W   = 474;
const PREVIEW_CANVAS_W = PREVIEW_NODE_W - 12; // 462px
const BTN_ROW_H        = 30;
const PREVIEW_WIDGET_H = PREVIEW_IMG_H + 108;  // 530 (+10 wrap padding, +2 border, +18 status, +26 slider, +26 bg row, +26 margin)
const UI_WIDGET_H      = BTN_ROW_H * 2 + PREVIEW_WIDGET_H; // 60 + 530 = 590
const KF_PANEL_H       = 98;  // キーフレームパネルの高さ（行A+タイムライン+行B+パディング）

// ================================================
// キーフレームパネル DOM を作成
// ================================================
function buildKeyframePanel(node) {
    const panel = document.createElement("div");
    panel.style.cssText = [
        "width:100%", "box-sizing:border-box",
        "padding:3px 6px 5px", "display:none",  // 初期非表示
        "flex-direction:column", "gap:3px",
        "background:#13131f", "border-top:1px solid #313244",
    ].join(";");

    const kfBtnSt = [
        "background:#313244", "border:1px solid #45475a",
        "border-radius:3px", "color:#cdd6f4",
        "cursor:pointer", "padding:2px 7px",
        "font-size:11px", "white-space:nowrap",
    ].join(";");

    // ---- 行A: 操作ボタン ----
    const rowA = document.createElement("div");
    rowA.style.cssText = "display:flex;align-items:center;gap:4px;height:26px;";

    const addBtn = document.createElement("button");
    addBtn.style.cssText = kfBtnSt + ";background:#1a3a2a;border-color:#2a6a3a;";
    addBtn.textContent = t("kfAddBtn");
    addBtn.title = t("kfAddTooltip");
    addBtn.onclick = () => addKeyframeAtCurrentFrame(node);

    const delBtn = document.createElement("button");
    delBtn.style.cssText = kfBtnSt + ";background:#3a1a1a;border-color:#6a2a2a;";
    delBtn.textContent = t("kfDelBtn");
    delBtn.title = t("kfDelTooltip");
    delBtn.onclick = () => deleteKeyframeAtCurrentFrame(node);

    const sep1 = document.createElement("span");
    sep1.style.cssText = "color:#45475a;font-size:11px;";
    sep1.textContent = "|";

    const addCamBtn = document.createElement("button");
    addCamBtn.style.cssText = kfBtnSt + ";background:#1a2a3a;border-color:#2a5a7a;";
    addCamBtn.textContent = t("kfAddCamBtn");
    addCamBtn.title = t("kfAddCamTooltip");
    addCamBtn.onclick = () => addCameraKeyframeAtCurrentFrame(node);

    const delCamBtn = document.createElement("button");
    delCamBtn.style.cssText = kfBtnSt + ";background:#2a1a2a;border-color:#5a2a5a;";
    delCamBtn.textContent = t("kfDelCamBtn");
    delCamBtn.title = t("kfDelCamTooltip");
    delCamBtn.onclick = () => deleteCameraKeyframeAtCurrentFrame(node);

    const sep1b = document.createElement("span");
    sep1b.style.cssText = "color:#45475a;font-size:11px;";
    sep1b.textContent = "|";

    const moveKeyBtn = document.createElement("button");
    moveKeyBtn.style.cssText = kfBtnSt;
    moveKeyBtn.textContent = t("kfMoveKeyBtn");
    moveKeyBtn.title = t("kfMoveKeyTooltip");
    moveKeyBtn.onclick = () => {
        node._kfMoveKeyMode = !node._kfMoveKeyMode;
        moveKeyBtn.style.cssText = node._kfMoveKeyMode
            ? kfBtnSt + ";background:#3a2a4a;border-color:#8a5a9a;outline:1px solid #aa77cc;"
            : kfBtnSt;
    };

    const sep1c = document.createElement("span");
    sep1c.style.cssText = "color:#45475a;font-size:11px;";
    sep1c.textContent = "|";

    const goToZeroBtn = document.createElement("button");
    goToZeroBtn.style.cssText = kfBtnSt;
    goToZeroBtn.textContent = t("kfGoToZeroBtn");
    goToZeroBtn.title = t("kfGoToZeroTooltip");
    goToZeroBtn.onclick = () => seekToFrame(node, 0);

    const prevBtn = document.createElement("button");
    prevBtn.style.cssText = kfBtnSt;
    prevBtn.textContent = "◀";
    prevBtn.title = "前のフレーム";
    prevBtn.onclick = () => seekToFrame(node, Math.max(0, node._kfCurrentFrame - 1));

    const frameInput = document.createElement("input");
    frameInput.type = "number";
    frameInput.min = "0";
    frameInput.style.cssText = "width:44px;background:#1a1a2a;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;text-align:center;";
    frameInput.value = "0";
    frameInput.addEventListener("change", () => {
        const f = parseInt(frameInput.value) || 0;
        seekToFrame(node, f);
    });
    node._kfCurrentFrameEl = frameInput;

    const frameSlash = document.createElement("span");
    frameSlash.style.cssText = "color:#888;font-size:11px;";
    frameSlash.textContent = "/";

    const totalInput = document.createElement("input");
    totalInput.type = "number";
    totalInput.min = "2";
    totalInput.style.cssText = "width:44px;background:#1a1a2a;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;text-align:center;";
    totalInput.value = "60";
    totalInput.addEventListener("change", () => {
        node._kfTotalFrames = Math.max(2, parseInt(totalInput.value) || 60);
        const w = findWidget(node, "layer_config");
        if (w) {
            let cfg = {}; try { cfg = JSON.parse(w.value || "{}"); } catch (_) {}
            cfg.kf_total_frames = node._kfTotalFrames;
            w.value = JSON.stringify(cfg);
        }
        updateTimelineCanvas(node);
    });
    node._kfTotalFramesEl = totalInput;

    const nextBtn = document.createElement("button");
    nextBtn.style.cssText = kfBtnSt;
    nextBtn.textContent = "▶";
    nextBtn.title = "次のフレーム";
    nextBtn.onclick = () => seekToFrame(node, node._kfCurrentFrame + 1);

    const sep2 = document.createElement("span");
    sep2.style.cssText = "color:#45475a;font-size:11px;margin-left:auto;";
    sep2.textContent = "|";

    const playBtn = document.createElement("button");
    playBtn.style.cssText = kfBtnSt + ";background:#1a2a4a;border-color:#2a4a8a;min-width:54px;";
    playBtn.textContent = t("kfPlayBtn");
    playBtn.title = t("kfPlayTooltip");
    playBtn.onclick = () => {
        if (node._kfPlaying) stopPlayback(node);
        else startPlayback(node);
    };
    node._kfPlayBtn = playBtn;

    const stopBtn = document.createElement("button");
    stopBtn.style.cssText = kfBtnSt;
    stopBtn.textContent = t("kfStopBtn");
    stopBtn.title = t("kfStopTooltip");
    stopBtn.onclick = () => stopPlayback(node);

    rowA.append(addBtn, delBtn, sep1, addCamBtn, delCamBtn, sep1b, moveKeyBtn, sep1c, goToZeroBtn, prevBtn, frameInput, frameSlash, totalInput, nextBtn);

    // ---- タイムラインキャンバス ----
    const tlCanvas = document.createElement("canvas");
    tlCanvas.width  = 450;
    tlCanvas.height = 34;
    tlCanvas.style.cssText = "width:100%;height:34px;cursor:pointer;border-radius:3px;display:block;";
    node._kfTimelineCanvas = tlCanvas;
    setupTimelineInteraction(tlCanvas, node);

    // ---- 行B: FPS + エクスポート ----
    const rowB = document.createElement("div");
    rowB.style.cssText = "display:flex;align-items:center;gap:4px;height:26px;";

    const clearBtn = document.createElement("button");
    clearBtn.style.cssText = kfBtnSt + ";background:#3a2a1a;border-color:#8a5a2a;";
    clearBtn.textContent = t("kfClearBtn");
    clearBtn.title = t("kfClearTooltip");
    clearBtn.onclick = () => {
        if (!confirm(t("kfClearTooltip") + "\n" + (node._keyframes?.length ? `(${node._keyframes.length}件)` : ""))) return;
        node._keyframes = [];
        node._kfCurrentFrame = 0;
        if (node._kfCurrentFrameEl) node._kfCurrentFrameEl.value = "0";
        const w = findWidget(node, "layer_config");
        if (w) {
            let cfg = {}; try { cfg = JSON.parse(w.value || "{}"); } catch (_) {}
            delete cfg.keyframes;
            w.value = JSON.stringify(cfg);
        }
        updateTimelineCanvas(node);
    };

    const fpsLabel = document.createElement("span");
    fpsLabel.style.cssText = "font-size:11px;color:#cdd6f4;flex-shrink:0;";
    fpsLabel.textContent = t("kfFpsLabel") + ":";

    const fpsInput = document.createElement("input");
    fpsInput.type = "number";
    fpsInput.min  = "1";
    fpsInput.max  = "60";
    fpsInput.style.cssText = "width:38px;background:#1a1a2a;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;text-align:center;";
    fpsInput.value = "24";
    fpsInput.addEventListener("change", () => {
        node._kfFps = Math.max(1, Math.min(60, parseInt(fpsInput.value) || 24));
        const w = findWidget(node, "layer_config");
        if (w) {
            let cfg = {}; try { cfg = JSON.parse(w.value || "{}"); } catch (_) {}
            cfg.kf_fps = node._kfFps;
            w.value = JSON.stringify(cfg);
        }
    });
    node._kfFpsEl = fpsInput;

    const progressEl = document.createElement("span");
    progressEl.style.cssText = "font-size:10px;color:#888;min-width:50px;";
    node._kfProgressEl = progressEl;

    // ---- プロジェクト保存ボタン ----
    const saveProjBtn = document.createElement("button");
    saveProjBtn.style.cssText = kfBtnSt + ";background:#2a1a4a;border-color:#5a3a8a;";
    saveProjBtn.textContent = t("kfSaveProjBtn");
    saveProjBtn.title = t("kfSaveProjTooltip");
    saveProjBtn.onclick = async () => {
        saveProjBtn.disabled = true;
        const ok = await saveKeyframeProject(node);
        saveProjBtn.disabled = false;
        if (ok) {
            saveProjBtn.style.outline = "2px solid #aa88ff";
            setTimeout(() => { saveProjBtn.style.outline = "none"; }, 800);
        }
    };

    const exportBtn = document.createElement("button");
    exportBtn.style.cssText = kfBtnSt + ";background:#1a2a4a;border-color:#2a4a8a;";
    exportBtn.textContent = t("kfExportBtn");
    exportBtn.title = t("kfExportTooltip");
    exportBtn.onclick = async () => {
        if (!(node._keyframes?.length >= 2)) {
            alert(t("kfNoKeyframes") + " (最低2つ必要)");
            return;
        }
        exportBtn.disabled = true;
        exportBtn.textContent = t("kfExporting");
        try {
            const blob = await exportVideoWebM(node, (f, total) => {
                if (node._kfProgressEl) node._kfProgressEl.textContent = `${f}/${total}`;
            });
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a   = document.createElement("a");
                a.href = url; a.download = "animation.webm";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
            }
        } catch (e) {
            console.error("[PSDFigureCreator] exportVideoWebM error:", e);
            alert("Export failed: " + e.message);
        }
        if (node._kfProgressEl) node._kfProgressEl.textContent = "";
        exportBtn.textContent = t("kfExportBtn");
        exportBtn.disabled = false;
    };

    const rowBSpacer = document.createElement("span");
    rowBSpacer.style.cssText = "flex:1;";

    rowB.append(clearBtn, fpsLabel, fpsInput, saveProjBtn, exportBtn, rowBSpacer, progressEl, playBtn, stopBtn);

    panel.append(rowA, tlCanvas, rowB);
    return panel;
}

// ================================================
// プレビューエリアDOMを作成
// ================================================
function buildPreviewWidget(node) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;padding:4px 6px 6px;box-sizing:border-box;";

    const previewBox = document.createElement("div");
    previewBox.style.cssText = [
        "width:100%",
        `height:${PREVIEW_IMG_H}px`,
        "position:relative",
        "overflow:hidden",
        "border-radius:4px",
        "border:1px solid #313244",
        "background:#111",
        "box-sizing:border-box",
    ].join(";");

    // インタラクティブキャンバス
    const canvas = document.createElement("canvas");
    canvas.width  = PREVIEW_CANVAS_W;
    canvas.height = PREVIEW_IMG_H;
    canvas.style.cssText = [
        "position:absolute",
        "top:0;left:0",
        "width:100%;height:100%",
        "cursor:grab",
        "display:block",
    ].join(";");

    previewBox.appendChild(canvas);

    const statusEl = document.createElement("div");
    statusEl.style.cssText = "font-size:10px;color:#6c7086;text-align:center;min-height:14px;margin-top:4px;";

    // ---- ポイントサイズスライダー ----
    const sliderWrap = document.createElement("div");
    sliderWrap.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 2px 2px;";
    const sliderLabel = document.createElement("span");
    sliderLabel.textContent = "Point Size";
    sliderLabel.style.cssText = "font-size:11px;color:#cdd6f4;white-space:nowrap;flex-shrink:0;";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.5";
    slider.max = "3.0";
    slider.step = "0.1";
    slider.value = "1.0";
    slider.style.cssText = "flex:1;accent-color:#4499ff;cursor:pointer;";
    const sliderVal = document.createElement("span");
    sliderVal.textContent = "1.0";
    sliderVal.style.cssText = "font-size:11px;color:#cdd6f4;width:28px;text-align:right;flex-shrink:0;";
    slider.addEventListener("input", () => {
        node._rigPointSize = parseFloat(slider.value);
        sliderVal.textContent = parseFloat(slider.value).toFixed(1);
        drawNodeCanvas(node);
    });
    sliderWrap.append(sliderLabel, slider, sliderVal);

    // ---- 背景コントロール行 ----
    const bgWrap = document.createElement("div");
    bgWrap.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 2px 0;flex-wrap:wrap;";

    // 背景色ピッカー
    const bgColorLabel = document.createElement("span");
    bgColorLabel.textContent = "BG";
    bgColorLabel.style.cssText = "font-size:11px;color:#cdd6f4;white-space:nowrap;flex-shrink:0;";
    const bgColorPick = document.createElement("input");
    bgColorPick.type = "color";
    bgColorPick.value = "#e0e0e0";
    bgColorPick.title = t("bgColorTooltip");
    bgColorPick.style.cssText = "width:28px;height:22px;padding:0;border:1px solid #45475a;border-radius:3px;cursor:pointer;background:none;";
    bgColorPick.addEventListener("input", () => {
        node._bgColor = bgColorPick.value;
        node._bgColorEnabled = true;
        node._bgImage = null;
        bgImgBtn.textContent = t("bgImageBtn");
        drawNodeCanvas(node);
    });

    // 背景色クリアボタン
    const bgColorClear = document.createElement("button");
    bgColorClear.textContent = "✕";
    bgColorClear.title = t("clearBgColorTooltip");
    bgColorClear.style.cssText = "padding:1px 5px;font-size:10px;background:#313244;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;cursor:pointer;";
    bgColorClear.addEventListener("click", () => {
        node._bgColorEnabled = false;
        drawNodeCanvas(node);
    });

    // 区切り
    const bgSep = document.createElement("span");
    bgSep.textContent = "|";
    bgSep.style.cssText = "color:#45475a;font-size:11px;flex-shrink:0;";

    // 背景画像ボタン（ファイルピッカー）
    const bgImgInput = document.createElement("input");
    bgImgInput.type = "file";
    bgImgInput.accept = "image/*";
    bgImgInput.style.cssText = "display:none;";
    const bgImgBtn = document.createElement("button");
    bgImgBtn.textContent = t("bgImageBtn");
    bgImgBtn.title = t("loadBgImageTooltip");
    bgImgBtn.style.cssText = "padding:2px 8px;font-size:11px;background:#313244;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;cursor:pointer;";
    bgImgBtn.addEventListener("click", () => bgImgInput.click());
    bgImgInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                node._bgImage = img;
                node._bgColorEnabled = false;
                bgImgBtn.textContent = `🖼 ${file.name.slice(0, 12)}`;
                drawNodeCanvas(node);
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        e.target.value = "";
    });

    // 背景画像クリアボタン
    const bgImgClear = document.createElement("button");
    bgImgClear.textContent = "✕";
    bgImgClear.title = t("clearBgImageTooltip");
    bgImgClear.style.cssText = "padding:1px 5px;font-size:10px;background:#313244;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;cursor:pointer;";
    bgImgClear.addEventListener("click", () => {
        node._bgImage = null;
        bgImgBtn.textContent = t("bgImageBtn");
        drawNodeCanvas(node);
    });

    // 接続インジケーター（background_image 入力がリンクされているときに表示）
    const bgLinkEl = document.createElement("span");
    bgLinkEl.style.cssText = "font-size:10px;color:#44cc44;white-space:nowrap;display:none;margin-left:auto;";
    bgLinkEl.textContent = t("externalConnected");

    bgWrap.append(bgColorLabel, bgColorPick, bgColorClear, bgSep, bgImgInput, bgImgBtn, bgImgClear, bgLinkEl);

    // 接続状態の変化で UI 更新
    const _origOnCon = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
        if (_origOnCon) _origOnCon.apply(this, args);
        const linked = !!(node.inputs?.find(i => i.name === 'background_image')?.link);
        bgLinkEl.style.display = linked ? "inline" : "none";
        drawNodeCanvas(node);
    };

    wrap.append(previewBox, statusEl, sliderWrap, bgWrap);

    // カメラ初期化
    node._camera        = { x: 0, y: 0, zoom: 1 };
    node._defaultCamera = { x: 0, y: 0, zoom: 1 };
    node._nodeCanvas    = canvas;
    node._previewStatusEl = statusEl;
    node._rigPointSize    = 1.0;
    node._bgColorEnabled  = false;
    node._bgColor         = "#e0e0e0";
    node._bgImage         = null;

    // チェッカー初期表示
    drawNodeCanvas(node);

    // パン/ズーム操作登録
    setupPreviewInteraction(canvas, node);

    return wrap;
}

// ================================================
// ComfyUI 拡張登録
// ================================================
app.registerExtension({
    name: "psd_loader.PSDFigureCreator",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const _origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const size = _origComputeSize
                ? _origComputeSize.call(this, out)
                : (out || new Float32Array(2));
            size[0] = PREVIEW_NODE_W;
            const kfExtra = (this._kfPanelVisible ? KF_PANEL_H : 0);
            const minH = UI_WIDGET_H + kfExtra + 80;
            if (size[1] < minH) size[1] = minH;
            return size;
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            const node = this;
            ensureCSS();

            hideWidget(node, "psd_filename");
            hideWidget(node, "layer_config");
            hideWidget(node, "image_data");

            // ---- 統合UIコンテナ ----
            const uiWrap = document.createElement("div");
            uiWrap.style.cssText = `width:100%;box-sizing:border-box;display:flex;flex-direction:column;`;

            const btnStyle = [
                "background:#313244",
                "border:1px solid #45475a",
                "border-radius:4px",
                "color:#cdd6f4",
                "padding:4px 8px",
                "cursor:pointer",
                "font-size:12px",
                "line-height:1.4",
                "transition:background .15s",
            ].join(";");

            // ---- 行1: psd + psd model + 更新 ----


            // ---- 行2: ライブラリPH / ポーズ保存PH / Setup / 🏷 / RP / RC ----
            const row2 = document.createElement("div");
            row2.style.cssText = "display:flex;gap:4px;padding:2px 6px 0;box-sizing:border-box;width:100%;height:30px;flex-shrink:0;";


            const libBtn = document.createElement("button");
            libBtn.style.cssText = btnStyle + ";flex-shrink:0;width:40px;height:26px;padding:1px;overflow:hidden;";
            libBtn.title = t("openLibraryTooltip");
            {
                const lc = document.createElement("canvas");
                lc.width = 36; lc.height = 22;
                lc.style.cssText = "display:block;border-radius:2px;pointer-events:none;";
                const lx = lc.getContext("2d");
                lx.fillStyle = "#1a1a2a"; lx.fillRect(0, 0, 36, 22);
                const libColors = ["#e05555", "#50a8e0", "#55c855", "#e0b040", "#9055e0", "#40c8c0"];
                const cw = 11, ch = 9;
                libColors.forEach((c, i) => {
                    lx.fillStyle = c;
                    lx.fillRect(1 + (i % 3) * (cw + 1), 2 + Math.floor(i / 3) * (ch + 1), cw, ch);
                });
                libBtn.appendChild(lc);
            }
            libBtn.onclick = () => new LibraryModal(node).open();

            // ---- ポーズ保存ボタン（クリック: 保存 / 右クリック: 適用） ----
            const poseSnapCanvas = document.createElement("canvas");
            poseSnapCanvas.width = 36; poseSnapCanvas.height = 22;
            poseSnapCanvas.style.cssText = "display:block;border-radius:2px;pointer-events:none;";
            const poseSnapCtx = poseSnapCanvas.getContext("2d");
            const _refreshPoseSnapThumb = (imgSrc) => {
                poseSnapCtx.clearRect(0, 0, 36, 22);
                if (imgSrc) {
                    const img = new Image();
                    img.onload = () => poseSnapCtx.drawImage(img, 0, 0, 36, 22);
                    img.src = imgSrc;
                } else {
                    // 暗い背景 + 人型シルエット
                    poseSnapCtx.fillStyle = "#1a1a2a";
                    poseSnapCtx.fillRect(0, 0, 36, 22);
                    poseSnapCtx.fillStyle = "rgba(160,180,210,0.75)";
                    const cx = 18;
                    // 頭
                    poseSnapCtx.beginPath(); poseSnapCtx.arc(cx, 5, 2.8, 0, Math.PI * 2); poseSnapCtx.fill();
                    // 胴体
                    poseSnapCtx.fillRect(cx - 2.5, 8.2, 5, 4.5);
                    // 腕
                    poseSnapCtx.fillRect(cx - 5.5, 8.5, 3, 2); poseSnapCtx.fillRect(cx + 2.5, 8.5, 3, 2);
                    // 脚
                    poseSnapCtx.fillRect(cx - 2.5, 12.8, 2, 4); poseSnapCtx.fillRect(cx + 0.5, 12.8, 2, 4);
                }
            };
            _refreshPoseSnapThumb(null);

            const poseSnapBtn = document.createElement("button");
            poseSnapBtn.style.cssText = btnStyle + ";flex-shrink:0;width:40px;height:26px;padding:1px;overflow:hidden;";
            poseSnapBtn.title = t("poseSaveTooltip");
            poseSnapBtn.appendChild(poseSnapCanvas);
            node._poseSnapshots = [];

            poseSnapBtn.addEventListener("click", async () => {
                const poseName = prompt(t("promptPoseName"));
                if (!poseName || !poseName.trim()) return;
                let config = {};
                try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}
                const snap = {
                    visibility: JSON.parse(JSON.stringify(config.visibility || {})),
                    pose:       JSON.parse(JSON.stringify(config.pose       || {})),
                    thumbnail:  null,
                };
                if (node._nodeCanvas) {
                    snap.thumbnail = captureThumbFromNode(node, 140);
                }
                node._poseSnapshots = [snap];
                try {
                    const res = await fetch("/psd_loader/library/poses", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ filename: poseName.trim(), content: snap }),
                    });
                    const d = await res.json();
                    if (d.error) throw new Error(d.error);
                    poseSnapBtn.style.outline = "2px solid #44ff88";
                    setTimeout(() => { poseSnapBtn.style.outline = "none"; }, 600);
                } catch (e) { alert(t("poseSaveFailed", e.message)); }
            });

            poseSnapBtn.addEventListener("contextmenu", async e => {
                e.preventDefault();
                const poseName = prompt(t("promptPoseNameWithSw"));
                if (!poseName || !poseName.trim()) return;
                let config = {};
                try { config = JSON.parse(findWidget(node, "layer_config")?.value || "{}"); } catch (_) {}
                const swAngles = {};
                (config.sw_layers || []).forEach(swl => {
                    (swl.points || []).forEach(pt => { swAngles[pt.id] = pt.angle ?? 0; });
                });
                const snap = {
                    visibility: JSON.parse(JSON.stringify(config.visibility || {})),
                    pose:       JSON.parse(JSON.stringify(config.pose       || {})),
                    sw_angles:  swAngles,
                    thumbnail:  null,
                };
                if (node._nodeCanvas) {
                    snap.thumbnail = captureThumbFromNode(node, 140);
                }
                node._poseSnapshots = [snap];
                try {
                    const res = await fetch("/psd_loader/library/poses", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ filename: poseName.trim(), content: snap }),
                    });
                    const d = await res.json();
                    if (d.error) throw new Error(d.error);
                    poseSnapBtn.style.outline = "2px solid #ff8844";
                    setTimeout(() => { poseSnapBtn.style.outline = "none"; }, 600);
                } catch (e) { alert(t("poseSaveFailed", e.message)); }
            });

            const setupBtn = document.createElement("button");
            setupBtn.style.cssText = btnStyle + ";flex:1;min-width:0;text-align:center;";
            setupBtn.textContent = "Setup";
            setupBtn.onclick = () => openLayerModal(node);

            node._showRigLabels = false;
            const nodeLblBtn = document.createElement("button");
            nodeLblBtn.style.cssText = btnStyle + ";flex-shrink:0;padding:4px 8px;";
            nodeLblBtn.textContent = "🏷";
            nodeLblBtn.title = t("toggleLabelsTooltip");
            nodeLblBtn.onclick = () => {
                node._showRigLabels = !node._showRigLabels;
                nodeLblBtn.style.outline = node._showRigLabels ? "2px solid #44ff88" : "none";
                drawNodeCanvas(node);
            };
            node._nodeLblBtn = nodeLblBtn;

            const rpBtn = document.createElement("button");
            rpBtn.style.cssText = btnStyle + ";flex-shrink:0;padding:4px 8px;";
            rpBtn.textContent = "RP";
            rpBtn.title = t("resetPoseNodeTooltip");
            rpBtn.onclick = () => resetNodePose(node);

            const rcBtn = document.createElement("button");
            rcBtn.style.cssText = btnStyle + ";flex-shrink:0;padding:4px 10px;";
            rcBtn.textContent = "RC";
            rcBtn.title = t("resetCameraTooltip");
            rcBtn.onclick = () => resetNodeCamera(node);

            row2.append(libBtn, poseSnapBtn, setupBtn, nodeLblBtn, rpBtn, rcBtn);

            // ---- 行3: Capture + KF パネルトグル ----
            const row3 = document.createElement("div");
            row3.style.cssText = "display:flex;gap:4px;padding:2px 6px 0;box-sizing:border-box;width:100%;height:30px;flex-shrink:0;";

            const captureBtn = document.createElement("button");
            captureBtn.style.cssText = btnStyle + ";flex:1;text-align:center;background:#1a4a2a;border-color:#2a7a4a;";
            captureBtn.textContent = t("captureBtn");
            captureBtn.title = t("captureBtnTooltip");
            captureBtn.onclick = async () => {
                const ok = captureNode(node);
                if (!ok) return;
                captureBtn.textContent = t("queuing");
                captureBtn.style.background = "#28a745";
                captureBtn.disabled = true;
                try {
                    await app.queuePrompt(0, 1);
                } catch (e) {
                    console.warn("[PSDFigureCreator] queuePrompt error:", e);
                }
                captureBtn.textContent = t("done");
                setTimeout(() => {
                    captureBtn.textContent = t("captureBtn");
                    captureBtn.style.background = "#1a4a2a";
                    captureBtn.disabled = false;
                }, 1800);
            };

            // ---- キーフレームパネルトグルボタン ----
            node._kfPanelVisible = false;
            node._keyframes      = [];
            node._kfCurrentFrame = 0;
            node._kfTotalFrames  = 60;
            node._kfFps          = 24;
            node._kfPlaying      = false;
            node._kfPlayRaf      = null;

            const kfToggleBtn = document.createElement("button");
            kfToggleBtn.style.cssText = btnStyle + ";flex-shrink:0;padding:4px 8px;";
            kfToggleBtn.textContent = t("kfPanelBtn");
            kfToggleBtn.title = t("kfPanelTooltip");

            // ---- キーフレームパネル ----
            const kfPanel = buildKeyframePanel(node);

            kfToggleBtn.onclick = () => {
                node._kfPanelVisible = !node._kfPanelVisible;
                kfPanel.style.display = node._kfPanelVisible ? "flex" : "none";
                kfToggleBtn.style.outline = node._kfPanelVisible ? "2px solid #aa88ff" : "none";
                node.size[1] = node.computeSize()[1];
                app.graph?.setDirtyCanvas(true, true);
            };

            row3.append(captureBtn, kfToggleBtn);

            // ---- プレビュー ----
            const previewWrap = buildPreviewWidget(node);

            uiWrap.append(row2, row3, kfPanel, previewWrap);

            node.addDOMWidget("psd_ui", "customtext", uiWrap, {
                getValue()    { return ""; },
                setValue()    {},
                computeSize(w) {
                    return [w, UI_WIDGET_H + (node._kfPanelVisible ? KF_PANEL_H : 0)];
                },
            });

            // ---- output_width / output_height 変更時にフレームを即再描画 ----
            for (const wname of ["output_width", "output_height"]) {
                const w = findWidget(node, wname);
                if (w) {
                    const origCb = w.callback;
                    w.callback = function (...args) {
                        origCb?.apply(this, args);
                        drawNodeCanvas(node);
                    };
                }
            }

            // ---- ファイル名復元 ----
            const fname = findWidget(node, "psd_filename")?.value;
            if (fname) {
                node._psdFilename = fname;
                if (node._psdBtn) node._psdBtn.textContent = `📂 ${fname}`;
            }

            // ---- ノードサイズ ----
            node.resizable = false;
            node.size[0] = PREVIEW_NODE_W;
            node.size[1] = node.computeSize()[1];
            node.onResize = function () {
                this.size[0] = PREVIEW_NODE_W;
                this.size[1] = this.computeSize()[1];
            };

            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (origConfigure) origConfigure.apply(this, arguments);
            hideWidget(this, "psd_filename");
            hideWidget(this, "layer_config");
            hideWidget(this, "image_data");

            this.resizable = false;
            this.size[0] = PREVIEW_NODE_W;
            this.size[1] = this.computeSize()[1];

            const node = this;

            // キーフレーム状態を layer_config から復元
            const lw = findWidget(node, "layer_config");
            if (lw) {
                let cfg = {};
                try { cfg = JSON.parse(lw.value || "{}"); } catch (_) {}
                if (Array.isArray(cfg.keyframes) && cfg.keyframes.length > 0) {
                    node._keyframes = JSON.parse(JSON.stringify(cfg.keyframes));
                    updateTimelineCanvas(node);
                }
                if (cfg.kf_total_frames !== undefined) {
                    node._kfTotalFrames = cfg.kf_total_frames;
                    if (node._kfTotalFramesEl) node._kfTotalFramesEl.value = cfg.kf_total_frames;
                }
                if (cfg.kf_fps !== undefined) {
                    node._kfFps = cfg.kf_fps;
                    if (node._kfFpsEl) node._kfFpsEl.value = cfg.kf_fps;
                }
            }

            const fname = findWidget(node, "psd_filename")?.value;
            if (fname) {
                node._psdFilename = fname;
                if (node._psdBtn) node._psdBtn.textContent = `📂 ${fname}`;

                (async () => {
                    try {
                        const res  = await fetch(`/psd_loader/layers?filename=${encodeURIComponent(fname)}`);
                        const data = await res.json();
                        if (data.error) return;
                        node._psdLayers = data.layers;
                        node._psdW      = data.width;
                        node._psdH      = data.height;
                        setDefaultCamera(node);
                        await refreshNodePreview(node);
                    } catch (_) {}
                })();
            }
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (origRemoved) origRemoved.apply(this, arguments);
            stopPlayback(this);
            if (this._layerImages) {
                for (const entry of Object.values(this._layerImages)) {
                    if (entry.objUrl) URL.revokeObjectURL(entry.objUrl);
                }
            }
        };
    },
});
