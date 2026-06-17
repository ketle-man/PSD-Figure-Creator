const LOCALES = {
    ja: {
        // ステータス
        loading:             "読み込み中...",
        previewError:        "プレビューエラー",
        psdNotSelected:      "PSD未選択",
        psdFileNotSelected:  "PSDファイル未選択",
        loadingLayerImages:  "レイヤー画像読み込み中...",
        loadError:           "ロードエラー: {0}",

        // アラート
        onlyPsdAllowed:       "PSDファイルのみ対応しています",
        uploadError:          "アップロードエラー: {0}",
        modelFileLoadFailed:  "モデルファイルの読み込みに失敗しました: {0}",
        maxGroupsReached:     "最大12グループまで登録できます",
        noAssignableLayer:    "割り当て可能なレイヤーがありません",
        noAssignableGroup:    "追加できるグループ/フォルダがありません",
        swGroupOrphaned:      "グループが解除されています。削除してください",
        noCustomGroupToRemove:"解除できるカスタムグループがありません",
        layerFetchFailed:     "レイヤー情報の取得に失敗しました: {0}",
        modelSaveFailed:      "モデル保存失敗: {0}",
        poseSaveFailed:       "ポーズ保存失敗: {0}",
        modelLoadFailed:      "モデル読み込み失敗: {0}",
        poseLoadFailed:       "ポーズ読み込み失敗: {0}",

        // 確認ダイアログ
        confirmNewRig:      "SWレイヤー・ポイント・リギング・ポーズをすべてクリアして新規作成しますか？",
        confirmDeleteModel: 'モデル "{0}" を削除しますか？',
        confirmDeletePose:  'ポーズ "{0}" を削除しますか？',

        // モーダルタイトル
        modalTitle: "PSD モデルエディタ",

        // ボタンラベル
        deleteRigBtn:  "🗑 削除",
        labelBtn:      "🏷 ラベル",
        previewLabel:  "プレビュー",
        poseBtn:       "📷 ポーズ",
        newBtn:        "✨ 新規",
        modelBtn:      "📂 model",
        addSwLayer:    "SW追加",
        deleteSwLayer: "SW削除",
        createGroup:   "グループ作成",
        ungroup:       "グループ解除",
        cancelBtn:     "キャンセル",
        saveBtn:       "💾 保存",
        applyBtn:      "適用",
        bgImageBtn:    "🖼 画像",
        externalConnected: "🔗 外部接続中",
        captureBtn:    "📸 Capture",
        queuing:       "⏳ Queuing...",
        done:          "✅ Done!",

        // ツールチップ
        deleteRigTooltip:     "選択レイヤーのリグを削除",
        setupHint:            "レイヤー選択 → キャンバスをクリックでポイント配置",
        labelBtnTooltip:      "リグポイントにレイヤー名を表示/非表示",
        resetPoseTooltip:     "ポーズをリセット（全リグレイヤーのangle/tx/tyを0に戻す）",
        clippingLayerBadge:        "クリッピングレイヤー（下のレイヤーにクリッピングマスクとして適用）",
        addLayerEntryTooltip:      "+L: 単体レイヤーを1スロットとして追加",
        addPieceEntryTooltip:      "+P: グループ/フォルダを追加（メンバーごとに個別スロット）",
        addCompositeEntryTooltip:  "+C: グループ/フォルダを追加（メンバーを合成して1スロット）",
        deleteGroupTooltip:   "選択グループを削除",
        poseSaveTooltip:      "ポーズ保存（右クリック: スイッチ状態込みで保存）",
        newBtnTooltip:        "リグ設定（SWレイヤー・ポイント・リギング・ポーズ）をクリアして新規作成",
        selectPsdTooltip:     "PSDファイルを選択",
        loadModelTooltip:     "保存済みモデルファイル (.psd-model.json) を読み込む",
        refreshTooltip:       "プレビューを更新",
        dblClickToRename:     "ダブルクリックで名前変更",
        clickSelectDblRename: "クリックで選択 / ダブルクリックで名前変更",
        deleteSwPointTooltip: "このSWポイントを削除",
        bgColorTooltip:       "背景色",
        clearBgColorTooltip:  "背景色をクリア",
        loadBgImageTooltip:   "背景画像を読み込む",
        clearBgImageTooltip:  "背景画像をクリア",
        openLibraryTooltip:   "ライブラリを開く",
        toggleLabelsTooltip:  "リグポイントのラベル表示切替",
        resetPoseNodeTooltip: "ポーズをリセット（セットアップ状態に戻す）",
        resetCameraTooltip:   "カメラをリセット",
        captureBtnTooltip:    "現在のレイヤー設定で画像を出力（Queue Promptで確定）",

        // タブ
        tabLayer:  "レイヤー",
        tabParent: "ペアレント",
        tabSwitch: "スイッチ",

        // プレフィックス
        customPrefix:   "[カスタム]",
        swPrefix:       "[SW]",
        groupPrefix:    "[グループ]",
        psdGroupPrefix: "[フォルダ]",
        layerPrefix:    "[レイヤー]",

        // ライブラリ
        noSavedModels:        "保存済みモデルなし",
        noSavedPoses:         "保存済みポーズなし",
        selectModel:          "モデルを選択",
        noThumbnail:          "サムネイルなし",
        poseSearchPlaceholder:"ポーズ検索",
        dropLayerHere:        "ここにレイヤーをドロップ",

        // プロンプトダイアログ
        promptGroupName:         "グループ名:",
        promptGroupDefault:      "グループ{0}",
        promptModelName:         "モデル名を入力してください:",
        promptPoseName:          "ポーズ名を入力してください:",
        promptPoseNameWithSw:    "ポーズ名を入力してください（スイッチ状態込み）:",

        // キャンバスオーバーレイ
        externalBgConnected:     "🔗 外部背景画像接続中",
        queuePromptToApply:      "Queue Prompt で反映されます",

        // キーフレーム
        kfPanelBtn:     "⏱",
        kfPanelTooltip: "キーフレームパネルを開閉",
        kfAddBtn:       "+KF",
        kfAddTooltip:   "現在フレームにキーフレームを追加（上書き）",
        kfDelBtn:       "🗑KF",
        kfDelTooltip:   "現在フレームのキーフレームを削除",
        kfPlayBtn:      "▶",
        kfStopBtn:      "■",
        kfPlayTooltip:  "再生",
        kfStopTooltip:  "停止",
        kfExportBtn:    "🎬 WebM",
        kfExportTooltip: "アニメーションを WebM 動画としてエクスポート（Chrome推奨）",
        kfExporting:    "エクスポート中...",
        kfFpsLabel:     "FPS",
        kfNoKeyframes:  "キーフレームが登録されていません",

        // ヘルプ
        helpBtn:   "?",
        helpTitle: "PSD モデルエディタ — ヘルプ",
        helpClose: "閉じる",
    },

    en: {
        loading:             "Loading...",
        previewError:        "Preview error",
        psdNotSelected:      "No PSD",
        psdFileNotSelected:  "No PSD file selected",
        loadingLayerImages:  "Loading layer images...",
        loadError:           "Load error: {0}",

        onlyPsdAllowed:       "Only PSD files are supported",
        uploadError:          "Upload error: {0}",
        modelFileLoadFailed:  "Failed to load model file: {0}",
        maxGroupsReached:     "Maximum 12 groups allowed",
        noAssignableLayer:    "No assignable layers",
        noAssignableGroup:    "No assignable group or folder",
        swGroupOrphaned:      "Group has been removed. Please delete this entry",
        noCustomGroupToRemove:"No custom groups to remove",
        layerFetchFailed:     "Failed to fetch layer info: {0}",
        modelSaveFailed:      "Model save failed: {0}",
        poseSaveFailed:       "Pose save failed: {0}",
        modelLoadFailed:      "Model load failed: {0}",
        poseLoadFailed:       "Pose load failed: {0}",

        confirmNewRig:      "Clear all SW layers, points, rigging, and poses to start fresh?",
        confirmDeleteModel: 'Delete model "{0}"?',
        confirmDeletePose:  'Delete pose "{0}"?',

        modalTitle: "PSD Model Editor",

        deleteRigBtn:  "🗑 Delete",
        labelBtn:      "🏷 Labels",
        previewLabel:  "Preview",
        poseBtn:       "📷 Pose",
        newBtn:        "✨ New",
        modelBtn:      "📂 model",
        addSwLayer:    "Add SW",
        deleteSwLayer: "Del SW",
        createGroup:   "Group",
        ungroup:       "Ungroup",
        cancelBtn:     "Cancel",
        saveBtn:       "💾 Save",
        applyBtn:      "Apply",
        bgImageBtn:    "🖼 Image",
        externalConnected: "🔗 Connected",
        captureBtn:    "📸 Capture",
        queuing:       "⏳ Queuing...",
        done:          "✅ Done!",

        deleteRigTooltip:     "Delete rig from selected layer",
        setupHint:            "Select layer → Click canvas to place point",
        labelBtnTooltip:      "Toggle rig point label visibility",
        resetPoseTooltip:     "Reset pose (zero angle/tx/ty for all rig layers)",
        clippingLayerBadge:        "Clipping layer (applied as clipping mask to the layer below)",
        addLayerEntryTooltip:      "+L: Add individual layer as 1 slot",
        addPieceEntryTooltip:      "+P: Add group/folder (1 slot per member layer)",
        addCompositeEntryTooltip:  "+C: Add group/folder (all members composited as 1 slot)",
        deleteGroupTooltip:   "Delete selected group",
        poseSaveTooltip:      "Save pose (right-click: save with switch states)",
        newBtnTooltip:        "Clear rig config (SW layers, points, rigging, poses) and start new",
        selectPsdTooltip:     "Select PSD file",
        loadModelTooltip:     "Load saved model file (.psd-model.json)",
        refreshTooltip:       "Refresh preview",
        dblClickToRename:     "Double-click to rename",
        clickSelectDblRename: "Click to select / Double-click to rename",
        deleteSwPointTooltip: "Delete this SW point",
        bgColorTooltip:       "Background color",
        clearBgColorTooltip:  "Clear background color",
        loadBgImageTooltip:   "Load background image",
        clearBgImageTooltip:  "Clear background image",
        openLibraryTooltip:   "Open library",
        toggleLabelsTooltip:  "Toggle rig point labels",
        resetPoseNodeTooltip: "Reset pose (return to setup state)",
        resetCameraTooltip:   "Reset camera",
        captureBtnTooltip:    "Output image with current layer config (confirm with Queue Prompt)",

        tabLayer:  "Layers",
        tabParent: "Parent",
        tabSwitch: "Switch",

        customPrefix:   "[Custom]",
        swPrefix:       "[SW]",
        groupPrefix:    "[Group]",
        psdGroupPrefix: "[Folder]",
        layerPrefix:    "[Layer]",

        noSavedModels:        "No saved models",
        noSavedPoses:         "No saved poses",
        selectModel:          "Select a model",
        noThumbnail:          "No thumbnail",
        poseSearchPlaceholder:"Search poses",
        dropLayerHere:        "Drop layer here",

        promptGroupName:         "Group name:",
        promptGroupDefault:      "Group{0}",
        promptModelName:         "Enter model name:",
        promptPoseName:          "Enter pose name:",
        promptPoseNameWithSw:    "Enter pose name (includes switch states):",

        externalBgConnected:     "🔗 External BG connected",
        queuePromptToApply:      "Apply with Queue Prompt",

        // Keyframe
        kfPanelBtn:     "⏱",
        kfPanelTooltip: "Toggle keyframe panel",
        kfAddBtn:       "+KF",
        kfAddTooltip:   "Add/overwrite keyframe at current frame",
        kfDelBtn:       "🗑KF",
        kfDelTooltip:   "Delete keyframe at current frame",
        kfPlayBtn:      "▶",
        kfStopBtn:      "■",
        kfPlayTooltip:  "Play",
        kfStopTooltip:  "Stop",
        kfExportBtn:    "🎬 WebM",
        kfExportTooltip: "Export animation as WebM video (Chrome recommended)",
        kfExporting:    "Exporting...",
        kfFpsLabel:     "FPS",
        kfNoKeyframes:  "No keyframes registered",

        // Help
        helpBtn:   "?",
        helpTitle: "PSD Model Editor — Help",
        helpClose: "Close",
    },

    zh: {
        loading:             "加载中...",
        previewError:        "预览错误",
        psdNotSelected:      "未选择PSD",
        psdFileNotSelected:  "未选择PSD文件",
        loadingLayerImages:  "正在加载图层图像...",
        loadError:           "加载错误: {0}",

        onlyPsdAllowed:       "仅支持PSD文件",
        uploadError:          "上传错误: {0}",
        modelFileLoadFailed:  "模型文件加载失败: {0}",
        maxGroupsReached:     "最多允许12个组",
        noAssignableLayer:    "没有可分配的图层",
        noAssignableGroup:    "没有可分配的组或文件夹",
        swGroupOrphaned:      "组已被解除，请删除此条目",
        noCustomGroupToRemove:"没有可解除的自定义组",
        layerFetchFailed:     "获取图层信息失败: {0}",
        modelSaveFailed:      "模型保存失败: {0}",
        poseSaveFailed:       "姿势保存失败: {0}",
        modelLoadFailed:      "模型加载失败: {0}",
        poseLoadFailed:       "姿势加载失败: {0}",

        confirmNewRig:      "清除所有SW图层、点位、绑定和姿势以重新开始？",
        confirmDeleteModel: '删除模型 "{0}"？',
        confirmDeletePose:  '删除姿势 "{0}"？',

        modalTitle: "PSD模型编辑器",

        deleteRigBtn:  "🗑 删除",
        labelBtn:      "🏷 标签",
        previewLabel:  "预览",
        poseBtn:       "📷 姿势",
        newBtn:        "✨ 新建",
        modelBtn:      "📂 model",
        addSwLayer:    "添加SW",
        deleteSwLayer: "删除SW",
        createGroup:   "创建组",
        ungroup:       "解除组",
        cancelBtn:     "取消",
        saveBtn:       "💾 保存",
        applyBtn:      "应用",
        bgImageBtn:    "🖼 图像",
        externalConnected: "🔗 已连接",
        captureBtn:    "📸 Capture",
        queuing:       "⏳ Queuing...",
        done:          "✅ Done!",

        deleteRigTooltip:     "删除选中图层的绑定",
        setupHint:            "选择图层 → 点击画布放置点位",
        labelBtnTooltip:      "切换绑定点标签显示",
        resetPoseTooltip:     "重置姿势（将所有绑定图层的angle/tx/ty归零）",
        clippingLayerBadge:        "剪贴蒙版图层（作为剪贴蒙版应用于下方图层）",
        addLayerEntryTooltip:      "+L: 将单个图层添加为1个槽位",
        addPieceEntryTooltip:      "+P: 添加组/文件夹（每个成员图层1个槽位）",
        addCompositeEntryTooltip:  "+C: 添加组/文件夹（所有成员合成为1个槽位）",
        deleteGroupTooltip:   "删除选中组",
        poseSaveTooltip:      "保存姿势（右键：含切换状态保存）",
        newBtnTooltip:        "清除绑定配置（SW图层、点位、绑定、姿势）并新建",
        selectPsdTooltip:     "选择PSD文件",
        loadModelTooltip:     "加载已保存的模型文件 (.psd-model.json)",
        refreshTooltip:       "刷新预览",
        dblClickToRename:     "双击重命名",
        clickSelectDblRename: "单击选择 / 双击重命名",
        deleteSwPointTooltip: "删除此SW点位",
        bgColorTooltip:       "背景颜色",
        clearBgColorTooltip:  "清除背景颜色",
        loadBgImageTooltip:   "加载背景图像",
        clearBgImageTooltip:  "清除背景图像",
        openLibraryTooltip:   "打开库",
        toggleLabelsTooltip:  "切换绑定点标签显示",
        resetPoseNodeTooltip: "重置姿势（恢复到设置状态）",
        resetCameraTooltip:   "重置摄像机",
        captureBtnTooltip:    "以当前图层配置输出图像（通过Queue Prompt确认）",

        tabLayer:  "图层",
        tabParent: "父级",
        tabSwitch: "切换",

        customPrefix:   "[自定义]",
        swPrefix:       "[SW]",
        groupPrefix:    "[组]",
        psdGroupPrefix: "[文件夹]",
        layerPrefix:    "[图层]",

        noSavedModels:        "无已保存模型",
        noSavedPoses:         "无已保存姿势",
        selectModel:          "选择模型",
        noThumbnail:          "无缩略图",
        poseSearchPlaceholder:"搜索姿势",
        dropLayerHere:        "在此处拖放图层",

        promptGroupName:         "组名称:",
        promptGroupDefault:      "组{0}",
        promptModelName:         "请输入模型名称:",
        promptPoseName:          "请输入姿势名称:",
        promptPoseNameWithSw:    "请输入姿势名称（含切换状态）:",

        externalBgConnected:     "🔗 外部背景图像已连接",
        queuePromptToApply:      "通过 Queue Prompt 应用",

        // 关键帧
        kfPanelBtn:     "⏱",
        kfPanelTooltip: "切换关键帧面板",
        kfAddBtn:       "+KF",
        kfAddTooltip:   "在当前帧添加/覆盖关键帧",
        kfDelBtn:       "🗑KF",
        kfDelTooltip:   "删除当前帧的关键帧",
        kfPlayBtn:      "▶",
        kfStopBtn:      "■",
        kfPlayTooltip:  "播放",
        kfStopTooltip:  "停止",
        kfExportBtn:    "🎬 WebM",
        kfExportTooltip: "将动画导出为WebM视频（推荐使用Chrome）",
        kfExporting:    "导出中...",
        kfFpsLabel:     "FPS",
        kfNoKeyframes:  "未注册关键帧",

        // 帮助
        helpBtn:   "?",
        helpTitle: "PSD模型编辑器 — 帮助",
        helpClose: "关闭",
    },
};

function _detectLang() {
    const l = (navigator.language || "en").toLowerCase();
    if (l.startsWith("zh")) return "zh";
    if (l.startsWith("ja")) return "ja";
    return "en";
}

let _lang = _detectLang();

export function setLang(lang) {
    if (LOCALES[lang]) _lang = lang;
}

export function getLang() {
    return _lang;
}

export function t(key, ...args) {
    const str = (LOCALES[_lang]?.[key] ?? LOCALES.en?.[key]) ?? key;
    return str.replace(/\{(\d+)\}/g, (_, i) => args[+i] ?? "");
}
