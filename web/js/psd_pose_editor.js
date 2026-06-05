import { app } from "/scripts/app.js";

// ============================================================
// ComfyUI 2.5D PSD Pose Editor フロントエンド
// ============================================================

// ワークフローシリアライズ時の base64 画像データ除外処理
setTimeout(() => {
    if (!app.graph) return;
    const _origSerialize = app.graph.serialize.bind(app.graph);
    app.graph.serialize = function (...args) {
        const data = _origSerialize(...args);
        if (data?.nodes) {
            for (const n of data.nodes) {
                if (n.type !== "PSDPoseEditor") continue;
                if (!n.widgets_values) continue;
                n.widgets_values[1] = ""; // image_data は widgets_values[1]
            }
        }
        return data;
    };
}, 500);

app.registerExtension({
    name: "Comfy.PSDPoseEditor",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PSDPoseEditor") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = onNodeCreated?.apply(this, arguments);
            const node = this;

            // バックエンドウィジェットを非表示にする
            setTimeout(() => {
                const wImageData = node.widgets?.find(w => w.name === "image_data");
                if (wImageData) {
                    wImageData.computeSize = () => [0, -4];
                    wImageData.hidden = true;
                }
                node.setDirtyCanvas(true, true);
            }, 0);

            // ============================================================
            // ---- ノード側表示UI（ポーズ専用コンパクトパネル） ----
            // ============================================================
            const nodeControlPanel = document.createElement("div");
            nodeControlPanel.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 6px;
                background: #1e1e1e;
                color: #e0e0e0;
                padding: 8px;
                border-radius: 8px;
                box-sizing: border-box;
                font-family: sans-serif;
                font-size: 11px;
                width: 260px;
                border: 1px solid #333;
            `;

            // ノード側ポーズ専用キャンバス
            const nodeCanvas = document.createElement("canvas");
            nodeCanvas.width = 1000;
            nodeCanvas.height = 1000;
            nodeCanvas.style.cssText =
                "width: 244px; height: 244px; background: #111; border-radius: 6px;" +
                "border: 1px solid #333; display: block; cursor: grab; flex-shrink: 0;";
            nodeControlPanel.appendChild(nodeCanvas);

            // ノード側ボタン行1: Setup | RP | RC
            const nodeButtonRow1 = document.createElement("div");
            nodeButtonRow1.style.cssText = "display: flex; gap: 5px; width: 100%;";

            const btnOpenSetup       = makeSmallButton("⚙️ Setup Editor", "#4a90d9", "Open Rig & Layer binding setup modal");
            btnOpenSetup.style.flex  = "1";
            const btnNodeResetPose   = makeSmallButton("RP", "#555",    "Reset Pose");
            const btnNodeResetCamera = makeSmallButton("RC", "#5a7a5a", "Reset Camera");

            nodeButtonRow1.appendChild(btnOpenSetup);
            nodeButtonRow1.appendChild(btnNodeResetPose);
            nodeButtonRow1.appendChild(btnNodeResetCamera);

            // キャプチャボタン
            const nodeCaptureBtn = makeSmallButton("📸 Capture Image", "#28a745", "Capture current pose image");
            nodeCaptureBtn.style.width   = "100%";
            nodeCaptureBtn.style.padding = "7px";

            nodeControlPanel.appendChild(nodeButtonRow1);
            nodeControlPanel.appendChild(nodeCaptureBtn);

            // ============================================================
            // ---- UIコンテナ作成（モーダルの中身・セットアップ専用） ----
            // ============================================================
            const container = document.createElement("div");
            container.style.cssText = `
                display: flex;
                flex-direction: column;
                background: #1e1e1e;
                color: #e0e0e0;
                padding: 15px;
                border-radius: 10px;
                box-sizing: border-box;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                font-size: 12px;
                gap: 10px;
                user-select: none;
                width: 720px;
                height: 560px;
                border: 1px solid #444;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
            `;

            // ---- タイトル行 ----
            const topRow = document.createElement("div");
            topRow.style.cssText = "display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap;";

            const modeLabel = document.createElement("div");
            modeLabel.textContent = "2.5D PSD Rig Editor (Setup Mode)";
            modeLabel.style.cssText = "font-weight: bold; font-size: 14px; color: #4a90d9;";
            topRow.appendChild(modeLabel);
            container.appendChild(topRow);

            // ---- メイン2カラムエリア ----
            const mainArea = document.createElement("div");
            mainArea.style.cssText = "display: flex; gap: 10px; height: 420px; align-items: stretch;";
            container.appendChild(mainArea);

            // --- 左カラム: モーダルキャンバス ---
            const leftCol = document.createElement("div");
            leftCol.style.cssText = "position: relative; width: 384px; height: 384px; background: #111; border-radius: 6px; overflow: hidden; border: 1px solid #333; flex-shrink: 0;";
            mainArea.appendChild(leftCol);

            const modalCanvas = document.createElement("canvas");
            modalCanvas.width = 1000;
            modalCanvas.height = 1000;
            modalCanvas.style.cssText = "width: 100%; height: 100%; display: block; cursor: grab;";
            leftCol.appendChild(modalCanvas);

            // --- 右カラム: リグ操作・レイヤーリスト ---
            const rightCol = document.createElement("div");
            rightCol.style.cssText = "display: flex; flex-direction: column; flex: 1; min-width: 200px; gap: 8px; overflow-y: auto; height: 420px; padding-right: 4px;";
            mainArea.appendChild(rightCol);

            // ジョイント追加・削除ツールバー
            const toolBar = document.createElement("div");
            toolBar.style.cssText = "display: flex; gap: 4px; flex-wrap: wrap; background: #252525; padding: 6px; border-radius: 6px; border: 1px solid #333;";
            rightCol.appendChild(toolBar);

            const btnAddBlue  = makeSmallButton("+🔵", "#2d5a9e", "Add Rotation Joint");
            const btnAddRed   = makeSmallButton("+🔴", "#9e2d2d", "Add Stretch & Rotate Joint");
            const btnLink     = makeSmallButton("🔗 Link",   "#5a5a5a", "Link selected joint to parent");
            const btnUnlink   = makeSmallButton("🔓 Unlink", "#5a5a5a", "Remove parent link");
            const btnDelJoint = makeSmallButton("🗑 Del",    "#662222", "Delete selected joint");
            const btnAutoBind = makeSmallButton("🤖 Auto",   "#6b3fa0", "Auto-bind layers by name matching");

            toolBar.appendChild(btnAddBlue);
            toolBar.appendChild(btnAddRed);
            toolBar.appendChild(btnLink);
            toolBar.appendChild(btnUnlink);
            toolBar.appendChild(btnDelJoint);
            toolBar.appendChild(btnAutoBind);

            // 選択ジョイントのプロパティ表示エリア
            const jointPropPanel = document.createElement("div");
            jointPropPanel.style.cssText = "background: #252525; padding: 8px; border-radius: 6px; border: 1px solid #333; display: flex; flex-direction: column; gap: 5px;";
            rightCol.appendChild(jointPropPanel);

            const propTitle = document.createElement("div");
            propTitle.textContent = "Selected Joint: None";
            propTitle.style.cssText = "font-weight: bold; border-bottom: 1px solid #3c3c3c; padding-bottom: 3px; margin-bottom: 3px; color: #4a90d9;";
            jointPropPanel.appendChild(propTitle);

            const propNameInput = document.createElement("input");
            propNameInput.type        = "text";
            propNameInput.placeholder = "Joint Name";
            propNameInput.disabled    = true;
            propNameInput.style.cssText = "background: #1a1a1a; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 3px 6px; font-size: 11px;";
            jointPropPanel.appendChild(propNameInput);

            const parentSelect = document.createElement("select");
            parentSelect.disabled = true;
            parentSelect.style.cssText = "background: #1a1a1a; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 3px; font-size: 11px;";
            jointPropPanel.appendChild(parentSelect);

            const typeSelect = document.createElement("select");
            typeSelect.disabled = true;
            typeSelect.style.cssText = "background: #1a1a1a; color: #fff; border: 1px solid #444; border-radius: 4px; padding: 3px; font-size: 11px;";
            const optBlue = document.createElement("option"); optBlue.value = "blue"; optBlue.textContent = "🔵 Rotation only";
            const optRed  = document.createElement("option"); optRed.value  = "red";  optRed.textContent  = "🔴 Rotate & Stretch";
            typeSelect.appendChild(optBlue);
            typeSelect.appendChild(optRed);
            jointPropPanel.appendChild(typeSelect);

            // レイヤー重ね順リストエリア
            const layerPanel = document.createElement("div");
            layerPanel.style.cssText = "display: flex; flex-direction: column; flex: 1; min-height: 180px; background: #252525; padding: 8px; border-radius: 6px; border: 1px solid #333;";
            rightCol.appendChild(layerPanel);

            const layerTitleRow = document.createElement("div");
            layerTitleRow.style.cssText = "display: flex; justify-content: space-between; font-weight: bold; border-bottom: 1px solid #3c3c3c; padding-bottom: 4px; margin-bottom: 5px; color: #4a90d9;";
            const layerTitle = document.createElement("span");
            layerTitle.textContent = "Layers (Depth order)";
            layerTitleRow.appendChild(layerTitle);
            layerPanel.appendChild(layerTitleRow);

            const layerScroll = document.createElement("div");
            layerScroll.style.cssText = "flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;";
            layerPanel.appendChild(layerScroll);

            // ---- アクション＆ファイル操作行 ----
            const bottomRow = document.createElement("div");
            bottomRow.style.cssText = "display: flex; gap: 6px; align-items: center; justify-content: flex-start; flex-wrap: wrap;";
            container.appendChild(bottomRow);

            const btnSaveRig        = makeSmallButton("💾 Save Rig",    "#3b6a9a", "Save rigging model setup");
            const btnLoadRig        = makeSmallButton("📂 Load Rig",    "#3b6a9a", "Load rigging model setup");
            const btnModalResetPose = makeSmallButton("🔄 Reset Pose",  "#555",    "Reset Pose");
            const btnClearRig       = makeSmallButton("Clear All",       "#5a3a3a", "Clear all joints and links");
            const btnImportPSDModal = makeSmallButton("📥 Import PSD",  "#28a745", "Import a PSD file from your PC");

            const fileInputRig = document.createElement("input");
            fileInputRig.type    = "file";
            fileInputRig.accept  = ".json";
            fileInputRig.style.display = "none";
            btnLoadRig.addEventListener("click", () => fileInputRig.click());

            bottomRow.appendChild(btnSaveRig);
            bottomRow.appendChild(btnLoadRig);
            bottomRow.appendChild(fileInputRig);
            bottomRow.appendChild(btnModalResetPose);
            bottomRow.appendChild(btnClearRig);
            bottomRow.appendChild(btnImportPSDModal);

            // ============================================================
            // --- 2.5D リギング・ポージングエンジンの定義 ---
            // ============================================================
            let psdWidth  = 1000;
            let psdHeight = 1000;
            let layers    = [];  // { index, name, depth, visible, left, top, width, height, has_pixels, img, boundJointId, opacity, bindData }
            let joints    = [];  // { id, name, type, x, y, parentJointId, angle, length, initLength }
            let selectedJointId = null;
            let linkingSourceId = null;

            // カメラ変換（ロード時に defaultCameraState を更新）
            const camera = { x: 0, y: 0, zoom: 0.35 };
            let defaultCameraState = { x: 0, y: 0, zoom: 0.35 };

            let isPanning       = false;
            let startPan        = { x: 0, y: 0 };
            let isDraggingJoint = false;
            let draggedJointId  = null;

            // カメラ座標系 ↔ キャンバスワールド座標系
            function screenToWorld(canvas, sx, sy) {
                const rect    = canvas.getBoundingClientRect();
                const canvasX = (sx - rect.left) * (canvas.width  / rect.width);
                const canvasY = (sy - rect.top)  * (canvas.height / rect.height);
                return {
                    x: (canvasX - canvas.width  / 2) / camera.zoom + canvas.width  / 2 - camera.x,
                    y: (canvasY - canvas.height / 2) / camera.zoom + canvas.height / 2 - camera.y,
                };
            }

            // --- レイヤー画像の非同期ロード ---
            function loadLayerImage(filename, index) {
                return new Promise((resolve) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload  = () => resolve(img);
                    img.onerror = () => resolve(null);
                    img.src = `/psd_pose_editor/layer_image?filename=${encodeURIComponent(filename)}&index=${index}`;
                });
            }

            // --- PSDファイルのロードと解析 ---
            async function loadPSD(filename) {
                if (!filename || filename === "None") return;
                try {
                    const response = await fetch(`/psd_pose_editor/parse?filename=${encodeURIComponent(filename)}`);
                    const data = await response.json();
                    if (data.error) { alert(`PSD Parse Error: ${data.error}`); return; }

                    psdWidth  = data.width;
                    psdHeight = data.height;
                    nodeCanvas.width   = psdWidth;
                    nodeCanvas.height  = psdHeight;
                    modalCanvas.width  = psdWidth;
                    modalCanvas.height = psdHeight;

                    // ノードキャンバス(244px表示)に収まる初期ズーム
                    camera.x    = 0;
                    camera.y    = 0;
                    camera.zoom = Math.min(244 / psdWidth, 244 / psdHeight) * 0.92;
                    defaultCameraState = { x: 0, y: 0, zoom: camera.zoom };

                    const loadedLayers = [];
                    for (const layer of data.layers) {
                        let img = null;
                        if (layer.has_pixels) img = await loadLayerImage(filename, layer.index);
                        loadedLayers.push({ ...layer, img, boundJointId: null, opacity: 1.0 });
                    }
                    layers = loadedLayers;
                    buildLayerListUI();
                    draw();
                } catch (e) {
                    console.error(e);
                    alert("Failed to load PSD file: " + e.message);
                }
            }

            // PSD変更時の監視
            const psdWidget = node.widgets?.find(w => w.name === "psd_file");
            if (psdWidget) {
                setTimeout(() => {
                    if (psdWidget.value && psdWidget.value !== "None") loadPSD(psdWidget.value);
                }, 100);
                const origCallback = psdWidget.callback;
                psdWidget.callback = function (value) {
                    origCallback?.apply(this, arguments);
                    loadPSD(value);
                };
            }

            // ============================================================
            // --- 骨格（ジョイント）管理機能 ---
            // ============================================================
            function addJoint(type = "blue") {
                const id = "j_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
                joints.push({
                    id, name: `Joint_${joints.length + 1}`, type,
                    x: psdWidth / 2, y: psdHeight / 2,
                    parentJointId: null, angle: 0, length: 1.0, initLength: 100,
                });
                selectedJointId = id;
                updateJointPropertyPanel();
                draw();
            }

            function deleteJoint(id) {
                if (!id) return;
                for (const j of joints) { if (j.parentJointId === id) j.parentJointId = null; }
                for (const l of layers) { if (l.boundJointId  === id) l.boundJointId  = null; }
                joints = joints.filter(j => j.id !== id);
                selectedJointId = null;
                updateJointPropertyPanel();
                buildLayerListUI();
                draw();
            }

            function calculateBindings() {
                for (const l of layers) {
                    if (!l.boundJointId) { l.bindData = null; continue; }
                    const joint = joints.find(j => j.id === l.boundJointId);
                    if (!joint) { l.bindData = null; continue; }

                    const cx = l.left + l.width  / 2;
                    const cy = l.top  + l.height / 2;

                    if (joint.parentJointId) {
                        const parent = joints.find(j => j.id === joint.parentJointId);
                        if (!parent) { l.bindData = null; continue; }
                        const dx = joint.x - parent.x;
                        const dy = joint.y - parent.y;
                        const initLength = Math.hypot(dx, dy) || 1;
                        joint.initLength = initLength;
                        const initAngle = Math.atan2(dy, dx);
                        const rx = cx - parent.x;
                        const ry = cy - parent.y;
                        const localX =  rx * Math.cos(-initAngle) - ry * Math.sin(-initAngle);
                        const localY =  rx * Math.sin(-initAngle) + ry * Math.cos(-initAngle);
                        l.bindData = { x_local: localX, y_local: localY, theta_local: -initAngle, initLength };
                    } else {
                        l.bindData = { x_local: cx - joint.x, y_local: cy - joint.y, theta_local: 0, initLength: 1 };
                    }
                }
            }

            function getJointPos(id, evaluated = {}) {
                if (evaluated[id]) return evaluated[id];
                const joint = joints.find(j => j.id === id);
                if (!joint) return { x: 0, y: 0, angle: 0 };

                if (!joint.parentJointId) {
                    evaluated[id] = { x: joint.x, y: joint.y, angle: 0 };
                    return evaluated[id];
                }

                const parentPos = getJointPos(joint.parentJointId, evaluated);
                const currentGlobalAngle = parentPos.angle + joint.angle;
                const currentLength = joint.initLength * joint.length;
                evaluated[id] = {
                    x: parentPos.x + Math.cos(currentGlobalAngle) * currentLength,
                    y: parentPos.y + Math.sin(currentGlobalAngle) * currentLength,
                    angle: currentGlobalAngle,
                };
                return evaluated[id];
            }

            function resetPose() {
                for (const j of joints) { j.angle = 0; j.length = 1.0; }
                draw();
            }

            function resetCamera() {
                camera.x    = defaultCameraState.x;
                camera.y    = defaultCameraState.y;
                camera.zoom = defaultCameraState.zoom;
                draw();
            }

            // ============================================================
            // --- レイヤー＆UIコントロール ---
            // ============================================================
            function buildLayerListUI() {
                layerScroll.innerHTML = "";
                layers.forEach((l) => {
                    if (!l.has_pixels) return;

                    const row = document.createElement("div");
                    row.style.cssText = `
                        display: flex; align-items: center; gap: 5px;
                        padding: 4px 6px; border-radius: 4px; background: #2e2e2e;
                        border: 1px solid ${l.boundJointId ? "#4a90d9" : "#3c3c3c"};
                        cursor: pointer; font-size: 11px;
                    `;

                    const visBtn = document.createElement("span");
                    visBtn.textContent = l.visible ? "👁" : "🚫";
                    visBtn.style.cursor = "pointer";
                    visBtn.title = "Toggle visibility";
                    visBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        l.visible = !l.visible;
                        visBtn.textContent = l.visible ? "👁" : "🚫";
                        draw();
                    });

                    const nameSpan = document.createElement("span");
                    nameSpan.textContent = l.name;
                    nameSpan.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

                    const bindSelect = document.createElement("select");
                    bindSelect.style.cssText = "background: #1a1a1a; color: #aaa; border: 1px solid #444; border-radius: 3px; font-size: 10px; max-width: 90px;";

                    const noneOpt = document.createElement("option");
                    noneOpt.value = ""; noneOpt.textContent = "No Joint";
                    bindSelect.appendChild(noneOpt);

                    joints.forEach((j) => {
                        const opt = document.createElement("option");
                        opt.value = j.id; opt.textContent = j.name;
                        if (l.boundJointId === j.id) opt.selected = true;
                        bindSelect.appendChild(opt);
                    });

                    bindSelect.addEventListener("change", () => {
                        l.boundJointId = bindSelect.value || null;
                        row.style.borderColor = l.boundJointId ? "#4a90d9" : "#3c3c3c";
                        calculateBindings();
                        draw();
                    });

                    row.appendChild(visBtn);
                    row.appendChild(nameSpan);
                    row.appendChild(bindSelect);
                    layerScroll.appendChild(row);
                });
            }

            function updateJointPropertyPanel() {
                const joint = joints.find(j => j.id === selectedJointId);
                if (!joint) {
                    propTitle.textContent  = "Selected Joint: None";
                    propNameInput.value    = "";
                    propNameInput.disabled = true;
                    parentSelect.disabled  = true;
                    typeSelect.disabled    = true;
                    parentSelect.innerHTML = "";
                    return;
                }
                propTitle.textContent  = `Selected Joint: ${joint.name}`;
                propNameInput.value    = joint.name;
                propNameInput.disabled = false;
                parentSelect.disabled  = false;
                typeSelect.disabled    = false;
                typeSelect.value       = joint.type;

                parentSelect.innerHTML = "";
                const optNoParent = document.createElement("option");
                optNoParent.value = ""; optNoParent.textContent = "Parent: None (Root)";
                parentSelect.appendChild(optNoParent);

                joints.forEach((j) => {
                    if (j.id === joint.id) return;
                    if (isAncestor(joint.id, j.id)) return;
                    const opt = document.createElement("option");
                    opt.value = j.id; opt.textContent = `Parent: ${j.name}`;
                    if (joint.parentJointId === j.id) opt.selected = true;
                    parentSelect.appendChild(opt);
                });
            }

            function isAncestor(parentCandidateId, childId) {
                const child = joints.find(j => j.id === childId);
                if (!child || !child.parentJointId) return false;
                if (child.parentJointId === parentCandidateId) return true;
                return isAncestor(parentCandidateId, child.parentJointId);
            }

            propNameInput.addEventListener("input", () => {
                const joint = joints.find(j => j.id === selectedJointId);
                if (joint) {
                    joint.name = propNameInput.value || "Unnamed";
                    propTitle.textContent = `Selected Joint: ${joint.name}`;
                    buildLayerListUI();
                    draw();
                }
            });

            parentSelect.addEventListener("change", () => {
                const joint = joints.find(j => j.id === selectedJointId);
                if (joint) { joint.parentJointId = parentSelect.value || null; calculateBindings(); draw(); }
            });

            typeSelect.addEventListener("change", () => {
                const joint = joints.find(j => j.id === selectedJointId);
                if (joint) { joint.type = typeSelect.value; draw(); }
            });

            // ============================================================
            // --- キャンバスレンダリング処理 ---
            // ============================================================
            function drawCanvas(canvas, context, mode) {
                if (!canvas) return;
                const ctx = context;
                const W = canvas.width;
                const H = canvas.height;
                ctx.clearRect(0, 0, W, H);

                ctx.save();
                ctx.translate(W / 2, H / 2);
                ctx.scale(camera.zoom, camera.zoom);
                ctx.translate(-W / 2 + camera.x, -H / 2 + camera.y);

                // グリッド背景
                const gridSize = 40;
                ctx.fillStyle = "#1e1e1e";
                ctx.fillRect(0, 0, W, H);
                ctx.fillStyle = "#262626";
                for (let y = 0; y < H; y += gridSize) {
                    for (let x = 0; x < W; x += gridSize) {
                        if (((x / gridSize) + (y / gridSize)) % 2 === 0) ctx.fillRect(x, y, gridSize, gridSize);
                    }
                }

                // レイヤー描画（重ね順：リストの後ろが背面）
                const evaluatedJoints = {};
                for (let i = layers.length - 1; i >= 0; i--) {
                    const l = layers[i];
                    if (!l.visible || !l.img) continue;
                    ctx.save();

                    if (mode === "pose" && l.boundJointId) {
                        const joint = joints.find(j => j.id === l.boundJointId);
                        if (joint) {
                            if (joint.parentJointId) {
                                const parentPos = getJointPos(joint.parentJointId, evaluatedJoints);
                                const jointPos  = getJointPos(joint.id, evaluatedJoints);
                                const dx = jointPos.x - parentPos.x;
                                const dy = jointPos.y - parentPos.y;
                                const currentLength = Math.hypot(dx, dy) || 1;
                                const currentAngle  = Math.atan2(dy, dx);
                                const S = l.bindData ? currentLength / l.bindData.initLength : 1.0;
                                ctx.translate(parentPos.x, parentPos.y);
                                ctx.rotate(currentAngle);
                                ctx.scale(S, 1.0);
                                if (l.bindData) {
                                    ctx.translate(l.bindData.x_local, l.bindData.y_local);
                                    ctx.rotate(l.bindData.theta_local);
                                }
                            } else {
                                const jointPos = getJointPos(joint.id, evaluatedJoints);
                                ctx.translate(jointPos.x, jointPos.y);
                                if (l.bindData) ctx.translate(l.bindData.x_local, l.bindData.y_local);
                            }
                        }
                    } else {
                        ctx.translate(l.left + l.width / 2, l.top + l.height / 2);
                    }

                    ctx.globalAlpha = l.opacity;
                    ctx.drawImage(l.img, -l.width / 2, -l.height / 2, l.width, l.height);
                    ctx.restore();
                }

                // 骨格描画
                if (mode === "setup") {
                    // ボーン線と矢印
                    joints.forEach((j) => {
                        if (!j.parentJointId) return;
                        const parent = joints.find(p => p.id === j.parentJointId);
                        if (!parent) return;
                        ctx.strokeStyle = "rgba(74, 144, 217, 0.7)";
                        ctx.lineWidth = 4;
                        ctx.beginPath(); ctx.moveTo(parent.x, parent.y); ctx.lineTo(j.x, j.y); ctx.stroke();
                        const angle = Math.atan2(j.y - parent.y, j.x - parent.x);
                        const arrowSize = 10;
                        ctx.fillStyle = "rgba(74, 144, 217, 0.9)";
                        ctx.beginPath();
                        ctx.moveTo(j.x, j.y);
                        ctx.lineTo(j.x - arrowSize * Math.cos(angle - 0.5), j.y - arrowSize * Math.sin(angle - 0.5));
                        ctx.lineTo(j.x - arrowSize * Math.cos(angle + 0.5), j.y - arrowSize * Math.sin(angle + 0.5));
                        ctx.fill();
                    });
                    // ジョイント点
                    joints.forEach((j) => {
                        const isSel = j.id === selectedJointId;
                        ctx.beginPath(); ctx.arc(j.x, j.y, isSel ? 18 : 12, 0, Math.PI * 2);
                        ctx.fillStyle = isSel ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.05)"; ctx.fill();
                        ctx.beginPath(); ctx.arc(j.x, j.y, 8, 0, Math.PI * 2);
                        ctx.fillStyle = j.type === "red" ? "#ff4a4a" : "#4a90d9"; ctx.fill();
                        ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
                    });
                } else {
                    // ポーズ骨格
                    joints.forEach((j) => {
                        if (!j.parentJointId) return;
                        const parent = joints.find(p => p.id === j.parentJointId);
                        if (!parent) return;
                        const pPos = evaluatedJoints[parent.id] || getJointPos(parent.id, evaluatedJoints);
                        const jPos = evaluatedJoints[j.id]    || getJointPos(j.id,    evaluatedJoints);
                        ctx.strokeStyle = "rgba(74, 144, 217, 0.5)"; ctx.lineWidth = 3;
                        ctx.beginPath(); ctx.moveTo(pPos.x, pPos.y); ctx.lineTo(jPos.x, jPos.y); ctx.stroke();
                    });
                    joints.forEach((j) => {
                        const pos   = evaluatedJoints[j.id] || getJointPos(j.id, evaluatedJoints);
                        const isSel = j.id === selectedJointId;
                        ctx.beginPath(); ctx.arc(pos.x, pos.y, isSel ? 14 : 10, 0, Math.PI * 2);
                        ctx.fillStyle = isSel ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)"; ctx.fill();
                        ctx.beginPath(); ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
                        ctx.fillStyle = j.type === "red" ? "#ff4a4a" : "#4a90d9"; ctx.fill();
                        ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
                    });
                }

                ctx.restore();
            }

            // モーダル参照（draw内で使用）
            let modalOverlay = null;

            function draw() {
                drawCanvas(nodeCanvas, nodeCanvas.getContext("2d"), "pose");
                if (modalOverlay && modalCanvas) {
                    drawCanvas(modalCanvas, modalCanvas.getContext("2d"), "setup");
                }
            }

            // ============================================================
            // --- キャンバスインタラクション登録関数 ---
            // ============================================================
            function setupCanvasInteraction(canvas, mode) {
                // カーソルフィードバック（ノードキャンバスのみ）
                canvas.addEventListener("mousedown", () => { canvas.style.cursor = "grabbing"; });
                canvas.addEventListener("mouseup",   () => { canvas.style.cursor = "grab"; });
                canvas.addEventListener("mouseleave",() => {
                    canvas.style.cursor = "grab";
                    isPanning       = false;
                    isDraggingJoint = false;
                    draggedJointId  = null;
                });

                canvas.addEventListener("mousedown", (e) => {
                    const worldPos = screenToWorld(canvas, e.clientX, e.clientY);

                    // 右クリック / Alt+クリック → パン（旧互換）
                    if (e.button === 2 || e.altKey) {
                        isPanning = true;
                        startPan  = { x: e.clientX, y: e.clientY };
                        e.preventDefault();
                        return;
                    }

                    // ジョイントにヒットするか確認
                    const evaluatedJoints = {};
                    let hitJoint = null;
                    for (const j of joints) {
                        let jx = j.x, jy = j.y;
                        if (mode === "pose") {
                            const pos = getJointPos(j.id, evaluatedJoints);
                            jx = pos.x; jy = pos.y;
                        }
                        if (Math.hypot(worldPos.x - jx, worldPos.y - jy) < 20 / camera.zoom) { hitJoint = j; break; }
                    }

                    if (hitJoint) {
                        // ジョイントドラッグ
                        selectedJointId = hitJoint.id;
                        isDraggingJoint = true;
                        draggedJointId  = hitJoint.id;
                        updateJointPropertyPanel();
                        if (mode === "setup" && linkingSourceId && linkingSourceId !== hitJoint.id) {
                            hitJoint.parentJointId = linkingSourceId;
                            linkingSourceId = null;
                            btnLink.style.background = "#5a5a5a";
                            btnLink.textContent = "🔗 Link";
                            calculateBindings();
                        }
                        draw();
                    } else {
                        // 空白領域 → パン開始
                        isPanning       = true;
                        startPan        = { x: e.clientX, y: e.clientY };
                        selectedJointId = null;
                        updateJointPropertyPanel();
                        draw();
                    }
                });

                canvas.addEventListener("mousemove", (e) => {
                    if (isPanning) {
                        const rect   = canvas.getBoundingClientRect();
                        const scaleX = canvas.width  / rect.width;
                        const scaleY = canvas.height / rect.height;
                        // クライアント px → ワールド座標の移動量（正方向 = コンテンツが追随）
                        const dx = (e.clientX - startPan.x) * scaleX / camera.zoom;
                        const dy = (e.clientY - startPan.y) * scaleY / camera.zoom;
                        camera.x += dx;
                        camera.y += dy;
                        startPan = { x: e.clientX, y: e.clientY };
                        draw();
                        return;
                    }
                    if (isDraggingJoint && draggedJointId) {
                        const worldPos = screenToWorld(canvas, e.clientX, e.clientY);
                        const joint    = joints.find(j => j.id === draggedJointId);
                        if (joint) {
                            if (mode === "setup") {
                                joint.x = worldPos.x; joint.y = worldPos.y;
                                calculateBindings();
                            } else {
                                if (joint.parentJointId) {
                                    const parent = joints.find(p => p.id === joint.parentJointId);
                                    if (parent) {
                                        const evalJoints = {};
                                        const parentPos = getJointPos(parent.id, evalJoints);
                                        const dx = worldPos.x - parentPos.x;
                                        const dy = worldPos.y - parentPos.y;
                                        joint.angle = Math.atan2(dy, dx) - parentPos.angle;
                                        if (joint.type === "red") {
                                            joint.length = Math.max(0.1, Math.min(4.0, Math.hypot(dx, dy) / (joint.initLength || 1)));
                                        }
                                    }
                                } else {
                                    joint.x = worldPos.x; joint.y = worldPos.y;
                                }
                            }
                            draw();
                        }
                    }
                });

                // ズーム：カーソル位置を中心に拡縮
                canvas.addEventListener("wheel", (e) => {
                    e.preventDefault();
                    const oldZoom = camera.zoom;
                    const factor  = 1.12;
                    camera.zoom   = e.deltaY < 0
                        ? Math.min(5.0, camera.zoom * factor)
                        : Math.max(0.05, camera.zoom / factor);

                    // カーソル下のワールド点が固定されるよう camera.x/y を補正
                    const rect    = canvas.getBoundingClientRect();
                    const scaleX  = canvas.width  / rect.width;
                    const scaleY  = canvas.height / rect.height;
                    const cvsX    = (e.clientX - rect.left) * scaleX;
                    const cvsY    = (e.clientY - rect.top)  * scaleY;
                    const W = canvas.width, H = canvas.height;
                    camera.x += (cvsX - W / 2) * (1 / camera.zoom - 1 / oldZoom);
                    camera.y += (cvsY - H / 2) * (1 / camera.zoom - 1 / oldZoom);

                    draw();
                }, { passive: false });

                canvas.addEventListener("contextmenu", (e) => e.preventDefault());
            }

            setupCanvasInteraction(nodeCanvas,  "pose");
            setupCanvasInteraction(modalCanvas, "setup");

            window.addEventListener("mouseup", () => {
                isPanning       = false;
                isDraggingJoint = false;
                draggedJointId  = null;
            });

            // ============================================================
            // --- ボタンイベントのバインド ---
            // ============================================================
            btnAddBlue.addEventListener("click", () => addJoint("blue"));
            btnAddRed.addEventListener( "click", () => addJoint("red"));

            btnLink.addEventListener("click", () => {
                if (!selectedJointId) { alert("Please select a joint first."); return; }
                if (linkingSourceId === selectedJointId) {
                    linkingSourceId = null;
                    btnLink.style.background = "#5a5a5a"; btnLink.textContent = "🔗 Link";
                } else {
                    linkingSourceId = selectedJointId;
                    btnLink.style.background = "#4a90d9"; btnLink.textContent = "⌛ Click target parent";
                }
            });

            btnUnlink.addEventListener("click", () => {
                const joint = joints.find(j => j.id === selectedJointId);
                if (joint) { joint.parentJointId = null; calculateBindings(); updateJointPropertyPanel(); draw(); }
            });

            btnDelJoint.addEventListener("click", () => deleteJoint(selectedJointId));

            btnAutoBind.addEventListener("click", () => {
                if (joints.length === 0) { alert("Please add joints before auto-binding."); return; }
                const mappingRules = {
                    head:         ["頭", "顔", "head", "face"],
                    neck:         ["首", "neck"],
                    chest:        ["胸", "胴", "chest", "body", "torso"],
                    abdomen:      ["腹", "腰", "abdomen", "hip", "waist"],
                    leftarm:      ["左上腕", "左腕", "leftarm", "l_arm", "left_arm"],
                    leftforearm:  ["左前腕", "左ひじ", "leftforearm", "l_forearm", "left_forearm"],
                    lefthand:     ["左手", "lefthand", "l_hand", "left_hand"],
                    rightarm:     ["右上腕", "右腕", "rightarm", "r_arm", "right_arm"],
                    rightforearm: ["右前腕", "右ひじ", "rightforearm", "r_forearm", "right_forearm"],
                    righthand:    ["右手", "righthand", "r_hand", "right_hand"],
                    leftleg:      ["左大腿", "左腿", "左太もも", "leftleg", "l_leg", "left_leg"],
                    leftshin:     ["左下腿", "左すね", "leftshin", "l_shin", "left_shin"],
                    leftfoot:     ["左足", "leftfoot", "l_foot", "left_foot"],
                    rightleg:     ["右大腿", "右腿", "右太もも", "rightleg", "r_leg", "right_leg"],
                    rightshin:    ["右下腿", "右すね", "rightshin", "r_shin", "right_shin"],
                    rightfoot:    ["右足", "rightfoot", "r_foot", "right_foot"],
                };
                let matchCount = 0;
                layers.forEach((l) => {
                    const lName = l.name.toLowerCase();
                    for (const joint of joints) {
                        const jName = joint.name.toLowerCase();
                        for (const [key, patterns] of Object.entries(mappingRules)) {
                            if ((jName.includes(key) || patterns.some(p => jName.includes(p)))
                                && patterns.some(p => lName.includes(p))) {
                                l.boundJointId = joint.id; matchCount++; break;
                            }
                        }
                    }
                });
                calculateBindings(); buildLayerListUI(); draw();
                alert(`Auto-bound ${matchCount} layers based on name matching rules.`);
            });

            btnClearRig.addEventListener("click", () => {
                if (confirm("Are you sure you want to clear all joints?")) {
                    joints = []; selectedJointId = null;
                    layers.forEach(l => l.boundJointId = null);
                    buildLayerListUI(); updateJointPropertyPanel(); draw();
                }
            });

            // --- リグの保存・読み込み (JSON) ---
            btnSaveRig.addEventListener("click", () => {
                const rigData = {
                    version: "1.0",
                    joints:   joints.map(j => ({ id: j.id, name: j.name, type: j.type, x: j.x, y: j.y, parentJointId: j.parentJointId })),
                    bindings: layers.filter(l => l.boundJointId).map(l => ({ layerName: l.name, jointId: l.boundJointId })),
                };
                const blob = new Blob([JSON.stringify(rigData, null, 2)], { type: "application/json" });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement("a");
                a.href     = url;
                a.download = `${psdWidget?.value || "character"}_rig.json`;
                a.click();
                URL.revokeObjectURL(url);
            });

            fileInputRig.addEventListener("change", (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const rigData = JSON.parse(event.target.result);
                        if (!rigData.joints) throw new Error("Invalid rig format");
                        joints = rigData.joints.map(j => ({ ...j, angle: 0, length: 1.0, initLength: 100 }));
                        layers.forEach(l => l.boundJointId = null);
                        if (rigData.bindings) {
                            rigData.bindings.forEach(b => {
                                const layer = layers.find(l => l.name === b.layerName);
                                if (layer) layer.boundJointId = b.jointId;
                            });
                        }
                        calculateBindings(); buildLayerListUI(); updateJointPropertyPanel(); draw();
                        alert("Rig data loaded successfully.");
                    } catch (err) { alert("Error parsing rig JSON: " + err.message); }
                };
                reader.readAsText(file);
            });

            btnModalResetPose.addEventListener("click",  resetPose);
            btnNodeResetPose.addEventListener("click",   resetPose);
            btnNodeResetCamera.addEventListener("click", resetCamera);

            // --- モーダル制御ロジック ---
            function openEditorModal() {
                if (modalOverlay) return;
                modalOverlay = document.createElement("div");
                modalOverlay.style.cssText = `
                    position: fixed; top: 0; left: 0;
                    width: 100vw; height: 100vh;
                    background: rgba(0, 0, 0, 0.75);
                    display: flex; align-items: center; justify-content: center;
                    z-index: 9999;
                `;

                if (!container.querySelector(".modal-close-btn")) {
                    const btnClose = makeSmallButton("✕ Close & Apply Setup", "#d9534f", "Save rigging model setup and close editor");
                    btnClose.classList.add("modal-close-btn");
                    btnClose.style.padding = "5px 12px";
                    btnClose.addEventListener("click", () => {
                        calculateBindings();
                        closeEditorModal();
                        draw();
                    });
                    topRow.appendChild(btnClose);
                }

                modalOverlay.appendChild(container);
                document.body.appendChild(modalOverlay);
                setTimeout(() => {
                    buildLayerListUI();
                    updateJointPropertyPanel();
                    drawCanvas(modalCanvas, modalCanvas.getContext("2d"), "setup");
                }, 50);
            }

            function closeEditorModal() {
                if (modalOverlay) { document.body.removeChild(modalOverlay); modalOverlay = null; }
            }

            btnOpenSetup.addEventListener("click", openEditorModal);

            // --- PSDファイルインポートロジック ---
            const fileInputImport = document.createElement("input");
            fileInputImport.type    = "file";
            fileInputImport.accept  = ".psd";
            fileInputImport.style.display = "none";
            container.appendChild(fileInputImport);

            btnImportPSDModal.addEventListener("click", () => fileInputImport.click());

            async function handlePSDImport(file) {
                if (!file) return;
                const formData = new FormData();
                formData.append("file", file);
                try {
                    btnImportPSDModal.textContent = "Uploading...";
                    btnImportPSDModal.style.background = "#6c757d";
                    const response = await fetch("/psd_pose_editor/upload", { method: "POST", body: formData });
                    const resData  = await response.json();
                    if (resData.error) { alert("Upload failed: " + resData.error); return; }

                    const newFilename = resData.filename;
                    const psdWgt = node.widgets?.find(w => w.name === "psd_file");
                    if (psdWgt) {
                        if (!psdWgt.options.values.includes(newFilename)) {
                            psdWgt.options.values.push(newFilename);
                            psdWgt.options.values.sort();
                        }
                        psdWgt.value = newFilename;
                        if (psdWgt.callback) psdWgt.callback(newFilename);
                    }
                    alert(`Imported ${newFilename} successfully!`);
                    loadPSD(newFilename);
                } catch (err) {
                    console.error(err);
                    alert("Import error: " + err.message);
                } finally {
                    btnImportPSDModal.textContent  = "📥 Import PSD";
                    btnImportPSDModal.style.background = "#28a745";
                    fileInputImport.value = "";
                }
            }

            fileInputImport.addEventListener("change", (e) => handlePSDImport(e.target.files[0]));

            // ============================================================
            // --- キャプチャ：出力サイズ(output_width × output_height)で全体合成 ---
            // ============================================================
            nodeCaptureBtn.addEventListener("click", () => {
                const imgWidget = node.widgets?.find(w => w.name === "image_data");
                if (!imgWidget) return;

                const outW = node.widgets?.find(w => w.name === "output_width")?.value  || 512;
                const outH = node.widgets?.find(w => w.name === "output_height")?.value || 512;

                // 出力キャンバス（カメラ変換なし・全体合成）
                const tempCanvas = document.createElement("canvas");
                tempCanvas.width  = outW;
                tempCanvas.height = outH;
                const tempCtx = tempCanvas.getContext("2d");

                // PSD全体をアスペクト比を保ってレターボックス配置
                const scaleX  = outW / psdWidth;
                const scaleY  = outH / psdHeight;
                const scale   = Math.min(scaleX, scaleY);
                const offsetX = (outW - psdWidth  * scale) / 2;
                const offsetY = (outH - psdHeight * scale) / 2;

                const evaluatedJoints = {};
                for (let i = layers.length - 1; i >= 0; i--) {
                    const l = layers[i];
                    if (!l.visible || !l.img) continue;
                    tempCtx.save();

                    // PSD座標系 → 出力座標系への変換
                    tempCtx.translate(offsetX, offsetY);
                    tempCtx.scale(scale, scale);

                    if (l.boundJointId) {
                        const joint = joints.find(j => j.id === l.boundJointId);
                        if (joint) {
                            if (joint.parentJointId) {
                                const parentPos = getJointPos(joint.parentJointId, evaluatedJoints);
                                const jointPos  = getJointPos(joint.id, evaluatedJoints);
                                const dx = jointPos.x - parentPos.x;
                                const dy = jointPos.y - parentPos.y;
                                const currentLength = Math.hypot(dx, dy) || 1;
                                const currentAngle  = Math.atan2(dy, dx);
                                const S = l.bindData ? currentLength / l.bindData.initLength : 1.0;
                                tempCtx.translate(parentPos.x, parentPos.y);
                                tempCtx.rotate(currentAngle);
                                tempCtx.scale(S, 1.0);
                                if (l.bindData) {
                                    tempCtx.translate(l.bindData.x_local, l.bindData.y_local);
                                    tempCtx.rotate(l.bindData.theta_local);
                                }
                            } else {
                                const jointPos = getJointPos(joint.id, evaluatedJoints);
                                tempCtx.translate(jointPos.x, jointPos.y);
                                if (l.bindData) tempCtx.translate(l.bindData.x_local, l.bindData.y_local);
                            }
                        } else {
                            tempCtx.translate(l.left + l.width / 2, l.top + l.height / 2);
                        }
                    } else {
                        tempCtx.translate(l.left + l.width / 2, l.top + l.height / 2);
                    }

                    tempCtx.globalAlpha = l.opacity;
                    tempCtx.drawImage(l.img, -l.width / 2, -l.height / 2, l.width, l.height);
                    tempCtx.restore();
                }

                imgWidget.value = tempCanvas.toDataURL("image/png");

                nodeCaptureBtn.textContent = "✅ Captured!";
                nodeCaptureBtn.style.background = "#155724";
                setTimeout(() => {
                    nodeCaptureBtn.textContent = "📸 Capture Image";
                    nodeCaptureBtn.style.background = "#28a745";
                }, 1800);
            });

            // --- DOM widget として追加 ---
            node.addDOMWidget("psd_pose_editor_widget", "psd_pose_editor", nodeControlPanel, {
                getValue()    { return ""; },
                setValue()    {},
                computeSize() { return [260, 310]; },
            });

            // ノードサイズ（リサイズ可能）
            node.size      = [280, 500];
            node.resizable = true;

            return ret;
        };
    }
});

// ---- ボタン生成ヘルパー ----
function makeSmallButton(label, bg, title = "") {
    const btn = document.createElement("button");
    btn.textContent = label;
    if (title) btn.title = title;
    btn.style.cssText = `
        padding: 4px 10px;
        background: ${bg};
        color: #fff;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 11px;
        font-weight: bold;
        transition: background 0.15s, opacity 0.15s;
        white-space: nowrap;
    `;
    btn.addEventListener("mouseover", () => { btn.style.opacity = "0.85"; });
    btn.addEventListener("mouseout",  () => { btn.style.opacity = "1.0"; });
    return btn;
}
