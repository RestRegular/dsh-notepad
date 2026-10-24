/**
 * dsh-notepad — Client half.
 *
 * Registers one floating notepad into `shell.overlay`. The panel is scoped to
 * the workspace of the session currently retained by the main view, so every
 * session opened from the same workspace shows the same note.
 *
 * The note is a list of segments rendered as cards in a scrollable list:
 *   - Enter splits the current segment into a new card; Shift+Enter is a
 *     normal line break;
 *   - every card can be inserted, replace the composer, or be sent directly;
 *   - sending archives the segment automatically, and only archived segments
 *     can be deleted;
 *   - a successful chat-composer send is mirrored into the workspace archive,
 *     de-duplicated by content;
 *   - archive cards are foldable: captured chat messages start folded while
 *     manual archives and notepad sends start expanded;
 *   - active segments can be multi-selected for batch insert / replace /
 *     send / archive, with one-click select-all.
 *
 * Data lives on the Host side at `<workspace>/.dsh/notepad.json` through the
 * same-origin route `/dsh-notepad/api/note`; the widget's position, size,
 * collapsed/hidden state and archive visibility are kept in localStorage.
 *
 * The whole file is wrapped in an IIFE: client bundles from every plugin are
 * concatenated into the same classic-script realm, so top-level bindings would
 * leak into a shared lexical scope and throw on reload.
 */
(() => {
const MODULE_ID = '@restregular/dsh-notepad';

/** Whether the host facade already holds a factory for this module id. */
function alreadyRegistered() {
  const factories = window.__ModuleLoader__?.factories;
  return factories !== undefined && typeof factories.has === 'function' && factories.has(MODULE_ID);
}

if (!alreadyRegistered()) {
window.__ModuleLoader__.load({
  id: MODULE_ID,
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef } = React;

    const NS = 'dsh-notepad';
    const API = '/dsh-notepad/api';
    const UI_KEY = 'dsh-notepad.ui.v1';
    const DEFAULT_W = 420;
    const DEFAULT_H = 460;
    const MIN_W = 320;
    const MIN_H = 240;
    const HEAD_H = 44;
    const SAVE_DELAY = 500;
    const MAX_SEGMENTS = 200;
    const MAX_SEGMENT_CHARS = 160000;
    const MAX_SEGMENT_HEIGHT = 240;
    const MAX_TITLE_CHARS = 200;
    const MAX_IMAGES = 20;
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    const MAX_OPTIMIZE_CHARS = 60000;
    const SIDEBAR_REFRESH_MS = 15000;
    const IMAGE_DELETE_DELAY = 5000;
    const OPTIMIZE_CACHE_LIMIT = 100;
    const EDGE_GAP = 8;
    /**
     * Archive sources. `manual` and `send` render expanded by default; a
     * `compose` card is a chat message captured automatically and starts
     * collapsed so a busy conversation does not bury the archive.
     */
    const ARCHIVE_ORIGIN = Object.freeze({
      manual: 'manual',
      send: 'send',
      compose: 'compose',
    });
    const ARCHIVE_ORIGIN_SET = new Set(Object.values(ARCHIVE_ORIGIN));
    /** Marks the shared conversation service after the send interceptor is installed. */
    const COMPOSER_PATCH_KEY = Symbol.for('dsh-notepad.composer-send.v1');
    const IMAGE_MIME = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };

    /** Host / system font stack; the default for the floating panel. */
    const FONT_STACK = 'var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif)';

    // ------------------------------------------------------------------
    // Settings store
    // ------------------------------------------------------------------
    const SETTINGS_KEY = 'dsh-notepad.settings.v1';
    const SETTINGS_EVENT = 'dsh-notepad:settings';
    const THEME_IDS = ['host', 'ocean', 'violet', 'emerald', 'amber', 'rose'];
    const UI_STYLE_IDS = ['flat', 'glass'];
    const FONT_IDS = ['system', 'sans', 'serif', 'mono'];
    const AI_PRESET_IDS = ['balanced', 'concise', 'professional', 'outline', 'custom'];
    const SHORTCUT_ACTIONS = ['toggle', 'reset', 'undo', 'redo', 'save'];
    /** While a settings field records a chord, plugin shortcuts must not react. */
    let shortcutRecording = false;
    const SHORTCUT_DEFAULTS = Object.freeze({
      toggle: 'Ctrl+Shift+N',
      reset: 'Ctrl+Shift+R',
      undo: 'Ctrl+Z',
      redo: 'Ctrl+Shift+Z',
      save: 'Ctrl+S',
    });
    const FONT_STACKS = {
      system: FONT_STACK,
      sans: '"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif',
      serif: 'Georgia,Cambria,"Songti SC","Noto Serif CJK SC","Times New Roman",serif',
      mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Code",monospace',
    };
    const AI_PRESET_PROMPTS = {
      balanced: [
        'You are a writing assistant for a developer notepad.',
        "Rewrite the user's note so it is clearer, more concise, and better organized,",
        'while preserving its original language, meaning, technical facts, Markdown,',
        'code, file paths, and image links. Never invent facts or drop information.',
      ].join(' '),
      concise: [
        'Tighten the note: remove redundancy and filler, prefer short sentences,',
        'and keep every technical fact, Markdown structure, code block, file path,',
        'and image link. Write in the original language.',
      ].join(' '),
      professional: [
        'Rewrite the note in a precise, professional technical-documentation tone.',
        'Keep every fact, identifier, code block, file path, and image link intact.',
        'Write in the original language.',
      ].join(' '),
      outline: [
        'Reorganize the note into a clear Markdown outline with short headings and',
        'bullet points where useful. Keep every fact, code block, file path, and',
        'image link intact. Write in the original language.',
      ].join(' '),
      custom: '',
    };
    /** @type {any} */
    let cachedSettings = null;
    const settingsListeners = new Set();

    const clampInt = (value, min, max, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    };

    const defaultSettings = () => ({
      theme: 'host',
      uiStyle: 'glass',
      blur: 10,
      font: 'system',
      fontSize: 13,
      saveMode: 'auto',
      undoLimit: 50,
      buttonGroups: true,
      groupDelay: 180,
      maxSegmentHeight: MAX_SEGMENT_HEIGHT,
      aiPreset: 'balanced',
      aiCustom: '',
      shortcuts: { ...SHORTCUT_DEFAULTS },
      defaultWidth: DEFAULT_W,
      defaultHeight: DEFAULT_H,
      defaultX: null,
      defaultY: null,
    });

    /** @param {unknown} raw @returns {any} */
    function sanitizeSettings(raw) {
      const base = defaultSettings();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
      const value = /** @type {any} */ (raw);
      const shortcuts = {};
      const source = value.shortcuts !== null && typeof value.shortcuts === 'object' ? value.shortcuts : {};
      for (const action of SHORTCUT_ACTIONS) {
        const candidate = typeof source[action] === 'string' && source[action].trim() !== ''
          ? source[action].trim()
          : SHORTCUT_DEFAULTS[action];
        shortcuts[action] = parseShortcut(candidate) === null ? SHORTCUT_DEFAULTS[action] : candidate;
      }
      return {
        theme: THEME_IDS.includes(value.theme) ? value.theme : base.theme,
        uiStyle: UI_STYLE_IDS.includes(value.uiStyle) ? value.uiStyle : base.uiStyle,
        blur: clampInt(value.blur, 0, 40, base.blur),
        font: FONT_IDS.includes(value.font) ? value.font : base.font,
        fontSize: clampInt(value.fontSize, 11, 20, base.fontSize),
        saveMode: value.saveMode === 'manual' ? 'manual' : 'auto',
        undoLimit: clampInt(value.undoLimit, 5, 200, base.undoLimit),
        buttonGroups: value.buttonGroups !== false,
        groupDelay: clampInt(value.groupDelay, 0, 1000, base.groupDelay),
        maxSegmentHeight: clampInt(value.maxSegmentHeight, 80, 800, base.maxSegmentHeight),
        aiPreset: AI_PRESET_IDS.includes(value.aiPreset) ? value.aiPreset : base.aiPreset,
        aiCustom: typeof value.aiCustom === 'string' ? value.aiCustom.slice(0, 4000) : '',
        shortcuts,
        defaultWidth: clampInt(value.defaultWidth, MIN_W, 1600, base.defaultWidth),
        defaultHeight: clampInt(value.defaultHeight, MIN_H, 1200, base.defaultHeight),
        defaultX: Number.isFinite(value.defaultX) ? Math.round(value.defaultX) : null,
        defaultY: Number.isFinite(value.defaultY) ? Math.round(value.defaultY) : null,
      };
    }

    function readSettings() {
      if (cachedSettings !== null) return cachedSettings;
      try {
        const raw = window.localStorage?.getItem(SETTINGS_KEY);
        cachedSettings = raw === null || raw === undefined
          ? defaultSettings()
          : sanitizeSettings(JSON.parse(raw));
      } catch {
        cachedSettings = defaultSettings();
      }
      return cachedSettings;
    }

    /** Persist a patch and notify every mounted consumer immediately. */
    function writeSettings(patch) {
      const current = readSettings();
      const next = sanitizeSettings({ ...current, ...patch });
      cachedSettings = next;
      try {
        window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* Storage may be unavailable; the session still uses the new value. */
      }
      for (const listener of [...settingsListeners]) {
        try {
          listener(next);
        } catch {
          /* One failing consumer must not block the others. */
        }
      }
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
          && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
        }
      } catch {
        /* CustomEvent is unavailable in some test shims. */
      }
      return next;
    }

    /** @param {(settings: any) => void} listener */
    function subscribeSettings(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    }

    /** Resolve the AI system instruction selected in settings. */
    function aiInstruction(settings) {
      if (settings.aiPreset === 'custom') return String(settings.aiCustom ?? '').trim().slice(0, 4000);
      return AI_PRESET_PROMPTS[settings.aiPreset] ?? AI_PRESET_PROMPTS.balanced;
    }

    // ------------------------------------------------------------------
    // Shortcut helpers
    // ------------------------------------------------------------------
    const SHORTCUT_NAMED_CODES = {
      enter: 'Enter',
      return: 'Enter',
      esc: 'Escape',
      escape: 'Escape',
      space: 'Space',
      spacebar: 'Space',
      tab: 'Tab',
      backspace: 'Backspace',
      delete: 'Delete',
      del: 'Delete',
      insert: 'Insert',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      arrowup: 'ArrowUp',
      up: 'ArrowUp',
      arrowdown: 'ArrowDown',
      down: 'ArrowDown',
      arrowleft: 'ArrowLeft',
      left: 'ArrowLeft',
      arrowright: 'ArrowRight',
      right: 'ArrowRight',
      minus: 'Minus',
      equal: 'Equal',
      comma: 'Comma',
      period: 'Period',
      slash: 'Slash',
      semicolon: 'Semicolon',
      quote: 'Quote',
      backquote: 'Backquote',
      bracketleft: 'BracketLeft',
      bracketright: 'BracketRight',
      backslash: 'Backslash',
    };
    const SHORTCUT_DISPLAY_TOKENS = {
      Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Minus: 'Minus', Equal: 'Equal', Comma: 'Comma', Period: 'Period', Slash: 'Slash',
      Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote',
      BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Backslash: 'Backslash',
    };

    /** @param {string} token @returns {string} */
    function shortcutCodeForToken(token) {
      const text = String(token ?? '').trim();
      if (text === '') return '';
      if (/^[a-zA-Z]$/u.test(text)) return `Key${text.toUpperCase()}`;
      if (/^[0-9]$/u.test(text)) return `Digit${text}`;
      if (/^F([1-9]|1[0-9]|2[0-4])$/iu.test(text)) return text.toUpperCase();
      return SHORTCUT_NAMED_CODES[text.toLowerCase()] ?? '';
    }

    /** @param {string} code @returns {string} */
    function shortcutDisplayToken(code) {
      if (/^Key[A-Z]$/u.test(code)) return code.slice(3);
      if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
      return SHORTCUT_DISPLAY_TOKENS[code] ?? code;
    }

    /**
     * Parse a canonical chord such as `Ctrl+Shift+N` into the shortcut
     * service's `{code, modifiers}` shape plus the raw booleans used by the
     * page-level keydown fallback.
     */
    function parseShortcut(value) {
      const text = String(value ?? '').trim();
      if (text === '') return null;
      const parts = text.split('+').map((part) => part.trim()).filter((part) => part !== '');
      if (parts.length < 2) return null;
      const token = parts.pop();
      let ctrl = false;
      let shift = false;
      let alt = false;
      let meta = false;
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'ctrl' || lower === 'control' || lower === 'primary') ctrl = true;
        else if (lower === 'shift') shift = true;
        else if (lower === 'alt' || lower === 'option' || lower === 'opt') alt = true;
        else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') meta = true;
        else return null;
      }
      if (!ctrl && !meta) return null;
      const code = shortcutCodeForToken(token);
      if (code === '') return null;
      const modifiers = [];
      if (ctrl || meta) modifiers.push('primary');
      if (shift) modifiers.push('shift');
      if (alt) modifiers.push('alt');
      return { code, modifiers, ctrl, meta, shift, alt };
    }

    /** @param {KeyboardEvent | any} event */
    function shortcutLabelForEvent(event) {
      const parts = [];
      if (event?.ctrlKey === true || event?.metaKey === true) parts.push('Ctrl');
      if (event?.shiftKey === true) parts.push('Shift');
      if (event?.altKey === true) parts.push('Alt');
      const code = typeof event?.code === 'string' && event.code !== '' ? event.code : '';
      let token = '';
      if (code !== '') token = shortcutDisplayToken(code);
      else token = shortcutDisplayToken(shortcutCodeForToken(event?.key ?? ''));
      if (token === '' || code === 'ControlLeft' || code === 'ControlRight'
        || code === 'ShiftLeft' || code === 'ShiftRight'
        || code === 'AltLeft' || code === 'AltRight'
        || code === 'MetaLeft' || code === 'MetaRight') return '';
      parts.push(token);
      return parts.join('+');
    }

    /** Whether a keydown event matches a parsed chord. */
    function shortcutMatches(event, parsed) {
      if (parsed === null || parsed === undefined) return false;
      const code = typeof event?.code === 'string' && event.code !== ''
        ? event.code
        : shortcutCodeForToken(event?.key ?? '');
      if (code !== parsed.code) return false;
      if (Boolean(event?.shiftKey) !== parsed.shift) return false;
      if (Boolean(event?.altKey) !== parsed.alt) return false;
      const chord = event?.ctrlKey === true || event?.metaKey === true;
      if (!chord) return false;
      return true;
    }

    /**
     * Whether the event target is a text entry surface with its own native
     * undo/redo history. The plugin must never intercept those chords there.
     */
    function isEditableTarget(target) {
      if (target === null || target === undefined) return false;
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (target.isContentEditable === true) return true;
      try {
        return typeof target.closest === 'function'
          && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null;
      } catch {
        return false;
      }
    }

    // ------------------------------------------------------------------
    // Copy
    // ------------------------------------------------------------------
    const DICT = {
      zh: {
        title: '记事本',
        editor: '分段内容',
        placeholder: '记录开发中遇到的问题，或下一阶段要做的事……',
        segmentPlaceholder: '新分段…',
        titlePlaceholder: '分段标题（可选）',
        segmentTitle: '分段标题',
        indexHint: '点击选择此段 · 拖动可排序',
        loading: '读取中…',
        empty: '还没有内容',
        unsaved: '未保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        loadFailed: '读取失败',
        retry: '重试',
        insert: '插入到输入框',
        insertSegment: '插入此段',
        insertSelected: '插入选中的 {n} 段',
        insertNewSession: '在新会话中插入',
        insertNewSelected: '在新会话中插入选中的 {n} 段',
        insertNewDone: '已在新会话中填入内容',
        insertNewUnavailable: '无法新建会话，内容已复制',
        inserted: '已插入输入框',
        insertEmpty: '没有可插入的内容',
        insertUnavailable: '输入框暂不可用，内容已复制',
        replace: '替换输入框内容',
        replaceSegment: '替换此段',
        replaceSelected: '替换为选中的 {n} 段',
        replaced: '已替换输入框内容',
        replaceUnavailable: '替换不可用，内容已复制',
        send: '发送',
        sendSegment: '发送此段',
        sendSelected: '发送选中的 {n} 段',
        sendNewSession: '在新会话中发送',
        sendNewSelected: '在新会话中发送选中的 {n} 段',
        sendNewDone: '已在新会话中发送',
        sendNewUnavailable: '无法新建会话，内容已复制',
        sending: '发送中…',
        sent: '已发送',
        sendFailed: '发送失败',
        sendUnavailable: '发送接口不可用，已插入输入框',
        copy: '复制全部',
        copied: '已复制',
        copyFailed: '复制失败',
        selectAll: '全选',
        clearSelection: '取消选择',
        selectHint: '全选',
        selected: '已选 {n} 段',
        selectSegment: '选择此段',
        merge: '合并分段',
        mergeSelected: '合并选中的 {n} 段',
        mergeHint: '至少选择 2 段才能合并',
        mergedToast: '已合并 {n} 段',
        optimizeSegment: 'AI 优化此段',
        optimizeSelected: 'AI 优化选中的 {n} 段',
        optimizeSelectHint: '勾选分段后可批量优化',
        optimizeAllProgress: 'AI 优化中 {done}/{total}',
        optimizing: '优化中…',
        undoOptimize: '撤销优化',
        optimizedToast: '已优化此段',
        optimizedCount: '已优化 {n} 段',
        optimizeUndone: '已撤销优化',
        optimizeEmpty: '没有可优化的文字',
        optimizeTooLong: '内容太长，无法优化',
        optimizeUnavailable: 'AI 服务不可用',
        optimizeFailed: '优化失败',
        dragSegment: '拖动排序',
        unsent: '{n} 条未发送',
        archive: '归档',
        archiveSegment: '归档此段',
        archiveSelected: '归档选中的 {n} 段',
        archived: '归档',
        archivedToast: '已归档，可在归档中查看',
        archivedCount: '已归档 {n} 段',
        showArchive: '显示归档',
        hideArchive: '隐藏归档',
        archiveCount: '归档 · {n}',
        archiveEmpty: '还没有归档的分段',
        noActive: '没有进行中的分段',
        restore: '恢复',
        restoreSegment: '恢复此段',
        restoreAll: '全部恢复',
        restoredToast: '已恢复',
        restoredCount: '已恢复 {n} 段',
        deleteSegment: '删除此段',
        deleteActiveSegment: '删除此段（不可恢复）',
        deleteConfirmTitle: '删除这个分段？',
        deleteConfirmBody: '删除后无法恢复。分段里的文字和图片引用会一起移除。',
        deleteConfirmHint: '此操作不可撤销',
        deleteConfirmCancel: '取消',
        deleteConfirmOk: '删除',
        deletedToast: '已删除',
        clearArchive: '清空归档',
        clearedArchive: '已清空 {n} 段归档',
        undo: '撤销',
        addSegment: '新建分段',
        tooManySegments: '最多 {n} 段',
        emptySegment: '（空分段）',
        collapse: '折叠',
        expand: '展开',
        minimize: '最小化',
        show: '显示记事本（{shortcut}）',
        chars: '{n} 字符',
        segments: '{n} 段',
        hintNext: '点击查看下一条快捷键',
        hintEnter: 'Enter 新建分段',
        hintNewline: 'Shift+Enter 分段内换行',
        hintInsert: 'Ctrl+Enter 插入当前分段',
        hintToggle: 'Ctrl+Shift+N 显示 / 隐藏浮窗',
        hintReset: 'Ctrl+Shift+R 复位浮窗',
        hintArrow: '↑ / ↓ 切换分段',
        hintPaste: '粘贴图片自动保存到工作区',
        hintUndo: 'Ctrl+Z 撤销操作（含插入 / 替换输入框；发送不可撤销）',
        hintCopy: '复制按钮可复制单段或选中分段',
        resetShortcut: '复位记事本位置和尺寸',
        workspace: '工作区',
        resize: '拖动调整大小',
        uiReset: '已复位浮窗位置和尺寸',
        addImage: '添加图片',
        removeImage: '移除图片',
        openImage: '打开图片',
        imagePreview: '图片预览',
        closePreview: '关闭预览',
        openOriginal: '打开原图',
        imageAdded: '已添加 {n} 张图片',
        imageFailed: '图片添加失败',
        imageUnsupported: '只支持 PNG / JPEG / WebP / GIF 图片',
        imageTooLarge: '图片太大（最大 20 MB）',
        imageTooMany: '每段最多 {n} 张图片',
        imageUploading: '图片处理中…',
        images: '{n} 张图片',
        dropImage: '松开以添加图片',
        imagePasteSaved: '已保存到 .dsh/notepad/images',
        settingsTab: '记事本',
        settingsTitle: '记事本设置',
        settingsIntro: '所有修改即时生效。',
        appearance: '外观',
        theme: '配色主题',
        themeHost: '跟随宿主',
        themeOcean: '海蓝',
        themeViolet: '紫罗兰',
        themeEmerald: '翠绿',
        themeAmber: '琥珀',
        themeRose: '玫瑰',
        uiStyle: 'UI 风格',
        uiFlat: '纯色扁平',
        uiGlass: '毛玻璃模糊',
        blur: '模糊程度',
        blurHint: '仅毛玻璃风格生效，单位 px。',
        font: '字体',
        fontSystem: '跟随宿主',
        fontSans: '无衬线',
        fontSerif: '衬线',
        fontMono: '等宽',
        fontSize: '字号',
        segmentMaxHeight: '分段卡片最大高度',
        segmentMaxHeightHint: '文本超过该高度后卡片内部才出现滚动条。',
        saveSection: '保存',
        saveMode: '保存方式',
        autoSave: '自动保存',
        autoSaveHint: '关闭后改为手动保存，记事本顶部会出现保存按钮。',
        manualSave: '手动保存',
        saveNow: '保存记事本',
        saveNowHint: '立即保存当前内容',
        savedToast: '已保存',
        manualHint: '手动保存已开启',
        historySection: '历史',
        undoLimit: '撤销步数上限',
        undoLimitHint: '最多保留 {n} 步；输入框内的撤销仍由浏览器原生处理。',
        undo: '撤销',
        redo: '重做',
        undone: '已撤销',
        redone: '已重做',
        groupsSection: '按钮组',
        buttonGroups: '启用按钮组模式',
        buttonGroupsHint: '启用后次级按钮 hover 展开；关闭后全部按钮直接显示。',
        groupDelay: '展开 hover 时间阈值',
        groupDelayHint: '鼠标停留多久后展开按钮组，单位毫秒。',
        expandAll: '全部展开',
        collapseAll: '全部折叠',
        collapseSegment: '折叠分段',
        expandSegment: '展开分段',
        shortcutsSection: '快捷键',
        shortcutToggle: '显示 / 隐藏记事本',
        shortcutReset: '复位浮窗位置和尺寸',
        shortcutUndo: '撤销',
        shortcutRedo: '重做',
        shortcutSave: '保存记事本',
        shortcutResetDefaults: '恢复默认快捷键',
        shortcutHint: '点击输入框后按下新的组合键即可绑定，必须包含 Ctrl / Cmd。',
        aiSection: 'AI 优化',
        aiPreset: '提示词预设',
        aiPresetBalanced: '通用润色',
        aiPresetConcise: '精简压缩',
        aiPresetProfessional: '专业文档',
        aiPresetOutline: '分点大纲',
        aiPresetCustom: '自定义',
        aiCustomPrompt: '自定义提示词',
        aiPresetPrompt: '预设提示词',
        aiPresetHint: '预设内容不可编辑；选择「自定义」后可修改。',
        aiCustomHint: '仅对记事本的 AI 优化请求生效；请保留 Markdown、代码与文件路径。',
        aiPromptHint: '优化结果仍会强制只返回正文，不会添加解释或代码围栏。',
        windowSection: '窗口',
        defaultWidth: '默认宽度',
        defaultHeight: '默认高度',
        resetDefaultSize: '恢复默认位置和尺寸数值',
        useCurrentGeometry: '将当前位置和尺寸设为默认',
        geometrySaved: '已将当前位置和尺寸设为默认',
        applyResetGeometry: '立即恢复浮窗位置和尺寸',
        geometryHint: '默认停靠在右下角；点击「将当前位置和尺寸设为默认」可捕获当前面板的位置与尺寸。',
        copySegment: '复制此段',
        copySelected: '复制选中的 {n} 段',
        workspaceMenu: '切换工作区',
        switchWorkspace: '已切换到该工作区的新会话',
        switchWorkspaceFailed: '无法切换工作区',
        deleteSelected: '删除选中的 {n} 段（不可恢复）',
        batchDelete: '批量删除',
        batchDeleteTitle: '删除选中的 {n} 个分段？',
        batchDeleteBody: '删除后无法恢复。分段里的文字和图片引用会一起移除。',
        batchDeleteHint: '此操作不可撤销',
        optimizeSelection: 'AI 优化选中内容',
        optimizeSelectionEmpty: '选中的内容为空',
        selectionOptimized: '已优化选中内容',
      },
      en: {
        title: 'Notepad',
        editor: 'Segment content',
        placeholder: 'Jot down problems, or what to build next…',
        segmentPlaceholder: 'New segment…',
        titlePlaceholder: 'Segment title (optional)',
        segmentTitle: 'Segment title',
        indexHint: 'Click to select · drag to reorder',
        loading: 'Loading…',
        empty: 'Nothing here yet',
        unsaved: 'Unsaved',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        loadFailed: 'Load failed',
        retry: 'Retry',
        insert: 'Insert into composer',
        insertSegment: 'Insert this segment',
        insertSelected: 'Insert {n} selected',
        insertNewSession: 'Insert into a new session',
        insertNewSelected: 'Insert {n} selected into a new session',
        insertNewDone: 'Filled into a new session',
        insertNewUnavailable: 'Could not create a session; copied instead',
        inserted: 'Inserted into composer',
        insertEmpty: 'Nothing to insert',
        insertUnavailable: 'Composer unavailable; copied instead',
        replace: 'Replace composer',
        replaceSegment: 'Replace with this segment',
        replaceSelected: 'Replace with {n} selected',
        replaced: 'Composer replaced',
        replaceUnavailable: 'Replace unavailable; copied instead',
        send: 'Send',
        sendSegment: 'Send this segment',
        sendSelected: 'Send {n} selected',
        sendNewSession: 'Send into a new session',
        sendNewSelected: 'Send {n} selected into a new session',
        sendNewDone: 'Sent into a new session',
        sendNewUnavailable: 'Could not create a session; copied instead',
        sending: 'Sending…',
        sent: 'Sent',
        sendFailed: 'Send failed',
        sendUnavailable: 'Send unavailable; inserted into composer',
        copy: 'Copy all',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        selectAll: 'Select all',
        clearSelection: 'Clear selection',
        selectHint: 'Select all',
        selected: '{n} selected',
        selectSegment: 'Select this segment',
        merge: 'Merge segments',
        mergeSelected: 'Merge {n} selected',
        mergeHint: 'Select at least 2 segments to merge',
        mergedToast: 'Merged {n} segments',
        optimizeSegment: 'Improve this segment with AI',
        optimizeSelected: 'Improve {n} selected with AI',
        optimizeSelectHint: 'Select segments to improve',
        optimizeAllProgress: 'Improving {done}/{total}',
        optimizing: 'Improving…',
        undoOptimize: 'Undo improvement',
        optimizedToast: 'Segment improved',
        optimizedCount: 'Improved {n} segments',
        optimizeUndone: 'Improvement undone',
        optimizeEmpty: 'Nothing to improve',
        optimizeTooLong: 'Too long to improve',
        optimizeUnavailable: 'AI service unavailable',
        optimizeFailed: 'Improve failed',
        dragSegment: 'Drag to reorder',
        unsent: '{n} unsent',
        archive: 'Archive',
        archiveSegment: 'Archive this segment',
        archiveSelected: 'Archive {n} selected',
        archived: 'Archived',
        archivedToast: 'Archived; available under Archive',
        archivedCount: 'Archived {n}',
        showArchive: 'Show archive',
        hideArchive: 'Hide archive',
        archiveCount: 'Archive · {n}',
        archiveEmpty: 'Nothing archived yet',
        noActive: 'No active segments',
        restore: 'Restore',
        restoreSegment: 'Restore this segment',
        restoreAll: 'Restore all',
        restoredToast: 'Restored',
        restoredCount: 'Restored {n}',
        deleteSegment: 'Delete this segment',
        deleteActiveSegment: 'Delete this segment (cannot be undone)',
        deleteConfirmTitle: 'Delete this segment?',
        deleteConfirmBody: 'This cannot be undone. The text and image references in the segment will be removed too.',
        deleteConfirmHint: 'This action cannot be undone',
        deleteConfirmCancel: 'Cancel',
        deleteConfirmOk: 'Delete',
        deletedToast: 'Deleted',
        clearArchive: 'Clear archive',
        clearedArchive: 'Cleared {n} archived',
        undo: 'Undo',
        addSegment: 'New segment',
        tooManySegments: 'At most {n} segments',
        emptySegment: '(empty segment)',
        collapse: 'Collapse',
        expand: 'Expand',
        minimize: 'Minimize',
        show: 'Show notepad ({shortcut})',
        chars: '{n} chars',
        segments: '{n} segments',
        hintNext: 'Click for the next shortcut',
        hintEnter: 'Enter creates a segment',
        hintNewline: 'Shift+Enter adds a line break',
        hintInsert: 'Ctrl+Enter inserts the current segment',
        hintToggle: 'Ctrl+Shift+N shows / hides the notepad',
        hintReset: 'Ctrl+Shift+R resets the floating window',
        hintArrow: '↑ / ↓ switch segments',
        hintPaste: 'Pasted images are saved in the workspace',
        hintUndo: 'Ctrl+Z undoes plugin actions, including composer inserts / replaces; sends cannot be undone',
        hintCopy: 'Copy buttons copy one segment or the selection',
        resetShortcut: 'Reset the notepad position and size',
        workspace: 'Workspace',
        resize: 'Drag to resize',
        uiReset: 'Window position and size reset',
        addImage: 'Add image',
        removeImage: 'Remove image',
        openImage: 'Open image',
        imagePreview: 'Image preview',
        closePreview: 'Close preview',
        openOriginal: 'Open original',
        imageAdded: 'Added {n} image(s)',
        imageFailed: 'Could not add image',
        imageUnsupported: 'Only PNG / JPEG / WebP / GIF images are supported',
        imageTooLarge: 'Image is too large (20 MB max)',
        imageTooMany: 'At most {n} images per segment',
        imageUploading: 'Processing image…',
        images: '{n} image(s)',
        dropImage: 'Drop to add the image',
        imagePasteSaved: 'Saved under .dsh/notepad/images',
        settingsTab: 'Notepad',
        settingsTitle: 'Notepad settings',
        settingsIntro: 'Changes apply immediately.',
        appearance: 'Appearance',
        theme: 'Color theme',
        themeHost: 'Follow host',
        themeOcean: 'Ocean',
        themeViolet: 'Violet',
        themeEmerald: 'Emerald',
        themeAmber: 'Amber',
        themeRose: 'Rose',
        uiStyle: 'UI style',
        uiFlat: 'Flat solid',
        uiGlass: 'Frosted glass',
        blur: 'Blur',
        blurHint: 'Frosted glass only, in pixels.',
        font: 'Font',
        fontSystem: 'Follow host',
        fontSans: 'Sans-serif',
        fontSerif: 'Serif',
        fontMono: 'Monospace',
        fontSize: 'Font size',
        segmentMaxHeight: 'Card max height',
        segmentMaxHeightHint: 'A segment scrolls internally only after its text grows past this height.',
        saveSection: 'Saving',
        saveMode: 'Save mode',
        autoSave: 'Auto save',
        autoSaveHint: 'Turn off for manual saving; a save button appears in the notepad header.',
        manualSave: 'Manual save',
        saveNow: 'Save notepad',
        saveNowHint: 'Save the current content now',
        savedToast: 'Saved',
        manualHint: 'Manual saving is on',
        historySection: 'History',
        undoLimit: 'Undo steps',
        undoLimitHint: 'Keep at most {n} steps; textareas keep their native undo.',
        undo: 'Undo',
        redo: 'Redo',
        undone: 'Undone',
        redone: 'Redone',
        groupsSection: 'Button groups',
        buttonGroups: 'Enable button groups',
        buttonGroupsHint: 'Secondary buttons expand on hover; disable to show every button at once.',
        groupDelay: 'Hover delay',
        groupDelayHint: 'How long the pointer must rest before a group expands, in milliseconds.',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        collapseSegment: 'Collapse segment',
        expandSegment: 'Expand segment',
        shortcutsSection: 'Shortcuts',
        shortcutToggle: 'Show / hide notepad',
        shortcutReset: 'Reset window geometry',
        shortcutUndo: 'Undo',
        shortcutRedo: 'Redo',
        shortcutSave: 'Save notepad',
        shortcutResetDefaults: 'Restore default shortcuts',
        shortcutHint: 'Click a field and press a new chord; Ctrl / Cmd is required.',
        aiSection: 'AI improve',
        aiPreset: 'Prompt preset',
        aiPresetBalanced: 'Balanced polish',
        aiPresetConcise: 'Tighten',
        aiPresetProfessional: 'Technical writing',
        aiPresetOutline: 'Outline',
        aiPresetCustom: 'Custom',
        aiCustomPrompt: 'Custom prompt',
        aiPresetPrompt: 'Preset prompt',
        aiPresetHint: 'Preset text is read-only; choose Custom to edit it.',
        aiCustomHint: 'Only used for notepad AI requests; keep Markdown, code, and file paths.',
        aiPromptHint: 'The result is still forced to plain rewritten text with no explanation or fence.',
        windowSection: 'Window',
        defaultWidth: 'Default width',
        defaultHeight: 'Default height',
        resetDefaultSize: 'Restore default position and size values',
        useCurrentGeometry: 'Use the current position and size as default',
        geometrySaved: 'Saved the current position and size as default',
        applyResetGeometry: 'Reset window position and size now',
        geometryHint: 'The default dock is the bottom-right corner; use "Use the current position and size as default" to capture the panel where it is now.',
        copySegment: 'Copy this segment',
        copySelected: 'Copy {n} selected',
        workspaceMenu: 'Switch workspace',
        switchWorkspace: 'Opened a new session in that workspace',
        switchWorkspaceFailed: 'Could not switch workspace',
        deleteSelected: 'Delete {n} selected (cannot be undone)',
        batchDelete: 'Batch delete',
        batchDeleteTitle: 'Delete {n} selected segments?',
        batchDeleteBody: 'This cannot be undone. The text and image references in those segments will be removed too.',
        batchDeleteHint: 'This action cannot be undone',
        optimizeSelection: 'Improve selected text with AI',
        optimizeSelectionEmpty: 'The selection is empty',
        selectionOptimized: 'Improved the selected text',
      },
    };

    /** Rotating shortcut tips shown one at a time in the footer. */
    const HINT_KEYS = [
      'hintEnter',
      'hintNewline',
      'hintInsert',
      'hintToggle',
      'hintReset',
      'hintUndo',
      'hintArrow',
      'hintCopy',
      'hintPaste',
    ];

    function preferredLanguage() {
      try {
        const tag = String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase();
        return tag.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    function fallbackTranslate() {
      return (key, params) => {
        const dict = DICT[preferredLanguage()] ?? DICT.zh;
        let out = dict[key] ?? DICT.zh[key] ?? key;
        if (params !== undefined && params !== null) {
          out = out.replace(/\{(\w+)\}/gu, (match, name) =>
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
        }
        return out;
      };
    }

    // ------------------------------------------------------------------
    // Icons
    // ------------------------------------------------------------------
    function Svg({ size = 16, children, viewBox = '0 0 16 16' }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    function NotepadIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('rect', {
          x: 2.6, y: 1.9, width: 10.8, height: 12.2, rx: 2.2,
          stroke: 'currentColor', strokeWidth: 1.25,
        }),
        h('path', {
          d: 'M5.4 5.5h5.2M5.4 8h5.2M5.4 10.5h3',
          stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round',
        }),
      );
    }

    /** Arrow pointing to the bottom-left corner. */
    function InsertIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M13.2 2.8 3.6 12.4',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M3.4 7.2v5.4h5.4',
          stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Two opposing arrows: replace the composer content. */
    function ReplaceIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M2.6 5.4h8.2M8.8 3.2l2.2 2.2-2.2 2.2',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.4 10.6H5.2M7.2 8.4 5 10.6l2.2 2.2',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Outline paper plane. */
    function SendIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M13.9 2.1 2.3 6.4l4.7 2.3L13.9 2.1Z',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13.9 2.1 9.4 13.7 7 8.7',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    function CopyIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('rect', {
          x: 5.2, y: 5.2, width: 8, height: 8, rx: 1.9,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M10.8 3.4c0-.7-.6-1.3-1.3-1.3H4.2c-.7 0-1.3.6-1.3 1.3v5.3c0 .7.6 1.3 1.3 1.3',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
      );
    }

    function ArchiveIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M2.2 3.2h11.6v2.8H2.2z',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.2 6v6.1c0 .7.6 1.3 1.3 1.3h7c.7 0 1.3-.6 1.3-1.3V6',
          stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6.2 8.6h3.6',
          stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round',
        }),
      );
    }

    function RestoreIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M8 10.2V3.2M5.6 5.6 8 3.2l2.4 2.4',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.1 9.8v1.5c0 .9.7 1.6 1.6 1.6h6.6c.9 0 1.6-.7 1.6-1.6V9.8',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
        }),
      );
    }

    function TrashIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M2.8 4.4h10.4',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6.1 4.4V3.2c0-.5.4-.9.9-.9h2c.5 0 .9.4.9.9v1.2',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M4.3 4.4 4.9 13c0 .6.5 1 1.1 1h4c.6 0 1.1-.4 1.1-1l.6-8.6',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
      );
    }

    function PlusIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M8 3.2v9.6M3.2 8h9.6',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      );
    }

    function CloseIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'm4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      );
    }

    /** Chevrons folded towards each other (collapse). */
    function ChevronsCollapseIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M4.2 5 8 8.8 11.8 5',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.2 11 8 7.2 11.8 11',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Chevrons opening away from each other (expand). */
    function ChevronsExpandIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M4.2 8.8 8 5 11.8 8.8',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.2 7.2 8 11 11.8 7.2',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Picture frame with a mountain: image attachment. */
    function ImageIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('rect', {
          x: 2.2, y: 3.2, width: 11.6, height: 9.6, rx: 1.6,
          stroke: 'currentColor', strokeWidth: 1.25, fill: 'none',
        }),
        h('circle', { cx: 5.9, cy: 6.5, r: 1.05, fill: 'currentColor' }),
        h('path', {
          d: 'M3.4 11.5 6.6 8.5l2 1.8 1.9-2.1 2.3 2.4',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
        }),
      );
    }

    /** Four-point sparkle: an AI improvement action. */
    function SparkleIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M8 1.8c.5 2.7 1.5 3.7 4.2 4.2-2.7.5-3.7 1.5-4.2 4.2-.5-2.7-1.5-3.7-4.2-4.2C6.5 5.5 7.5 4.5 8 1.8Z',
          stroke: 'currentColor', strokeWidth: 1.2,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.4 9.6c.3 1.5.8 2 2.3 2.3-1.5.3-2 .8-2.3 2.3-.3-1.5-.8-2-2.3-2.3 1.5-.3 2-.8 2.3-2.3Z',
          stroke: 'currentColor', strokeWidth: 1.1,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Curved arrow: undo the last AI improvement. */
    function UndoIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M5.4 4.2 2.8 6.8l2.6 2.6',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3 6.8h5.3c2.7 0 4.9 2.2 4.9 4.9',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Two panels, the second with a plus: start a new session. */
    function NewSessionIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('rect', {
          x: 1.9, y: 3.2, width: 5.1, height: 9.4, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.25,
        }),
        h('rect', {
          x: 8.7, y: 3.2, width: 5.4, height: 9.4, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.25,
        }),
        h('path', {
          d: 'M11.4 6.1v3.8M9.5 8h3.8',
          stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round',
        }),
      );
    }

    /** Two panels and a paper plane: send into a new session. */
    function NewSessionSendIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('rect', {
          x: 1.9, y: 3.2, width: 5.1, height: 9.4, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.25,
        }),
        h('rect', {
          x: 8.7, y: 3.2, width: 5.4, height: 9.4, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.25,
        }),
        h('path', {
          d: 'M9.6 8.1 13.4 6.4 11.6 10.2 10.8 8.4Z',
          stroke: 'currentColor', strokeWidth: 1.1,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Floppy disk with a small arrow: save the note now. */
    function SaveIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M3.2 2.6h7.1l2.5 2.5v8.3H3.2Z',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M5.2 2.6v3.4h4V2.6M5.2 13.4v-3.2h5.6v3.2',
          stroke: 'currentColor', strokeWidth: 1.15,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10.9 9.3v2.9M9.7 11.1l1.2 1.2 1.2-1.2',
          stroke: 'currentColor', strokeWidth: 1.15,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Curved arrow pointing forward: redo the last undone action. */
    function RedoIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M10.6 4.2 13.2 6.8l-2.6 2.6',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M13 6.8H7.7c-2.7 0-4.9 2.2-4.9 4.9',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Chevron pointing down: expand a card or open a dropdown. */
    function ChevronDownIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M4.2 6.2 8 10l3.8-3.8',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Chevron pointing right: a collapsed card. */
    function ChevronRightIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M6.4 4.2 10.2 8l-3.8 3.8',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Circular arrow: reset the floating window geometry. */
    function ResetIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.3 2.7v3.4H9.9',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Arrow leaving a frame: open the original image. */
    function OpenIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M9.4 3.2h3.4v3.4M12.8 3.2 7.6 8.4',
          stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.4 9.4v2.3c0 .7-.6 1.3-1.3 1.3H4.6c-.7 0-1.3-.6-1.3-1.3V5.2c0-.7.6-1.3 1.3-1.3h2.3',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
      );
    }

    /** Two arrows converging: merge selected segments into one. */
    function MergeIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M3.2 3.4v2.2c0 1.4 1.1 2.5 2.5 2.5h4.6c1.4 0 2.5 1.1 2.5 2.5v2.2',
          stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.2 12.6v-2.2c0-1.4 1.1-2.5 2.5-2.5h4.6c1.4 0 2.5-1.1 2.5-2.5V3.4',
          stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Arrow towards the bottom-right corner: minimize to the corner icon. */
    function MinimizeIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M4.2 4.2 11.4 11.4',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M6.8 11.6h4.8V6.8',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    const CSS = `.dsh-np-card{--np-accent:var(--dsw-alias-state-business-primary,#4176e6);--np-accent-fg:#fff;--np-surface:var(--dsw-alias-bg-layer-1,#fff);--np-surface-2:var(--dsw-alias-bg-layer-2,#fff);--np-tint:transparent;--np-font:${FONT_STACK};--np-font-size:13px;--np-blur:10px;--np-group-delay:.18s;--np-seg-max:240px;position:fixed;z-index:30;display:flex;flex-direction:column;box-sizing:border-box;width:${DEFAULT_W}px;max-width:calc(100vw - 16px);height:${DEFAULT_H}px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:14px;background:color-mix(in srgb,var(--np-tint) 4%,var(--np-surface));color:var(--dsw-alias-label-primary,#1f2430);box-shadow:var(--dsw-elevation-prominent,0 20px 50px rgb(15 23 42/.22),0 2px 8px rgb(15 23 42/.08));overflow:hidden;backdrop-filter:saturate(1.2) blur(var(--np-blur));font-family:var(--np-font,${FONT_STACK});font-size:var(--np-font-size,13px);line-height:1.5;transition:height .2s ease,opacity .18s ease,transform .18s ease}
.dsh-np-card[data-np-style=glass]{--np-surface:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 84%,transparent);--np-surface-2:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 90%,transparent);backdrop-filter:saturate(1.25) blur(var(--np-blur))}
.dsh-np-card[data-np-style=flat]{backdrop-filter:none;box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgb(15 23 42/.18),0 1px 3px rgb(15 23 42/.08))}
.dsh-np-card[data-np-theme=ocean]{--np-accent:#2f6fed;--np-tint:#2f6fed}
.dsh-np-card[data-np-theme=violet]{--np-accent:#7c5cf0;--np-tint:#7c5cf0}
.dsh-np-card[data-np-theme=emerald]{--np-accent:#12986b;--np-tint:#12986b}
.dsh-np-card[data-np-theme=amber]{--np-accent:#c07a11;--np-tint:#f0a61f}
.dsh-np-card[data-np-theme=rose]{--np-accent:#d64b76;--np-tint:#d64b76}
.dsh-np-card[data-hidden=true]{opacity:0;visibility:hidden;pointer-events:none;transform:translateY(10px) scale(.97);transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}
.dsh-np-card[data-resizing=true]{transition:none;user-select:none}
.dsh-np-card[data-minimized=true]{border-bottom-color:transparent}
.dsh-np-head{display:flex;align-items:center;gap:7px;flex:none;height:${HEAD_H}px;padding:0 8px 0 12px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08));cursor:grab;user-select:none;touch-action:none;background:var(--np-surface);background:linear-gradient(180deg,var(--np-surface),color-mix(in srgb,var(--np-surface-2) 72%,var(--np-surface)))}
.dsh-np-card[data-minimized=true] .dsh-np-head{border-bottom-color:transparent}
.dsh-np-head:active{cursor:grabbing}
.dsh-np-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,#9aa3b2);transition:background .15s}
.dsh-np-dot[data-state=dirty],.dsh-np-dot[data-state=saving]{background:var(--dsw-alias-state-warn-primary,#f5a524)}
.dsh-np-dot[data-state=saving]{animation:dsh-np-pulse 1s ease-in-out infinite}
.dsh-np-dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#e25555)}
.dsh-np-dot[data-state=saved]{background:var(--dsw-alias-state-success-primary,#2fb36d)}
.dsh-np-title{flex:none;font-size:12.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.dsh-np-ws{position:relative;display:inline-flex;min-width:0;flex:0 1 auto;max-width:128px}
.dsh-np-workspace{min-width:0;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px 1px 7px;border:0;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280);font:inherit;font-size:10.5px;line-height:16px;flex:0 1 auto;display:inline-flex;align-items:center;gap:2px;cursor:pointer}
.dsh-np-workspace:hover{color:var(--dsw-alias-label-primary,#1f2430);background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.1))}
.dsh-np-ws[data-open=true] .dsh-np-workspace{color:var(--np-accent);background:color-mix(in srgb,var(--np-accent) 12%,transparent)}
.dsh-np-ws-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-np-ws-chevron{flex:none;opacity:.7}
.dsh-np-ws-menu{position:absolute;top:calc(100% + 5px);left:0;z-index:40;min-width:168px;max-width:250px;max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.14));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 14px 34px rgb(15 23 42/.22));animation:dsh-np-fade .12s ease-out}
.dsh-np-ws-item{display:flex;align-items:center;gap:6px;width:100%;padding:4px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:11.5px;line-height:17px;text-align:left;cursor:pointer}
.dsh-np-ws-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-ws-item[data-current=true]{color:var(--np-accent);font-weight:600}
.dsh-np-ws-item-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-np-ws-item-count{flex:none;margin-left:auto;padding:0 5px;border-radius:8px;background:color-mix(in srgb,var(--np-accent) 12%,transparent);color:var(--np-accent);font-size:9.5px;line-height:15px;font-variant-numeric:tabular-nums}
.dsh-np-ws-empty{padding:5px 7px;color:var(--dsw-alias-label-caption,#9aa3b2);font-size:11px}
.dsh-np-spacer{flex:1 1 auto;min-width:0}
.dsh-np-btn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background .12s,color .12s,opacity .12s}
.dsh-np-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-btn[data-active=true]{background:color-mix(in srgb,var(--np-accent) 12%,transparent);color:var(--np-accent)}
.dsh-np-btn[data-accent=true]{background:var(--np-accent);color:var(--np-accent-fg)}
.dsh-np-btn[data-accent=true]:hover:not(:disabled){background:color-mix(in srgb,var(--np-accent) 88%,#000);color:var(--np-accent-fg)}
.dsh-np-btn[data-danger=true]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#e25555);background:var(--dsw-alias-interactive-bg-hover-danger,rgb(236 19 19/.08))}
.dsh-np-btn:disabled{opacity:.38;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-np-btn:focus-visible,.dsh-np-segbtn:focus-visible,.dsh-np-link:focus-visible,.dsh-np-empty-add:focus-visible,.dsh-np-toast-action:focus-visible,.dsh-np-selectall input:focus-visible,.dsh-np-check input:focus-visible,.dsh-np-title-add:focus-visible,.dsh-np-preview-btn:focus-visible,.dsh-np-confirm-btn:focus-visible,button.dsh-np-hint:focus-visible,.dsh-np-restore:focus-visible,.dsh-np-img-open:focus-visible,.dsh-np-img-remove:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.dsh-np-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:8px 10px 0;opacity:1;transition:opacity .16s ease,visibility 0s linear 0s}
.dsh-np-card[data-minimized=true] .dsh-np-body{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,visibility 0s linear .16s}
.dsh-np-tools{position:relative;display:flex;align-items:flex-start;flex:none;height:auto;min-height:36px;box-sizing:border-box;padding:0 2px 4px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08));overflow:hidden}
.dsh-np-toolbar-actions{position:absolute;right:2px;top:0;z-index:1;display:flex;align-items:center;flex-wrap:nowrap;gap:4px;max-width:none}
.dsh-np-toolbar-actions>*{flex:none}
.dsh-np-selectall{position:relative;z-index:2;align-self:stretch;display:inline-flex;align-items:center;gap:6px;min-width:0;padding:0 14px 0 2px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;white-space:nowrap;background:color-mix(in srgb,var(--np-surface) 80%,transparent);backdrop-filter:saturate(1.15) blur(var(--np-blur));-webkit-backdrop-filter:saturate(1.15) blur(var(--np-blur))}
.dsh-np-selectall::after{content:"";position:absolute;right:-12px;top:0;bottom:0;width:12px;background:linear-gradient(90deg,color-mix(in srgb,var(--np-surface) 80%,transparent),transparent);pointer-events:none}
.dsh-np-selectall input{width:14px;height:14px;margin:0;accent-color:var(--np-accent);cursor:pointer;flex:none}
.dsh-np-selectall input:disabled{cursor:default;opacity:.45}
.dsh-np-selcount{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.dsh-np-list{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;padding:8px 2px 8px 0;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-np-seg{display:flex;flex-direction:column;flex:none;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:10px;background:var(--np-surface-2);transition:border-color .12s,background .12s,opacity .12s;animation:dsh-np-item-in .16s ease-out}
.dsh-np-seg[data-selected=true]{border-color:var(--np-accent);background:color-mix(in srgb,var(--np-accent) 6%,var(--np-surface-2));box-shadow:0 0 0 1px var(--np-accent) inset}
.dsh-np-seg[data-archived=true]{border-style:dashed;background:transparent;opacity:.82;animation:none}
.dsh-np-seg[data-leaving=true]{animation:dsh-np-item-out .16s ease-in forwards;pointer-events:none}
.dsh-np-seg[data-collapsed=true] .dsh-np-editor{display:none}
.dsh-np-seg-preview{padding:0 10px 8px;color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;max-height:38px;overflow:hidden;mask-image:linear-gradient(180deg,#000 60%,transparent)}
.dsh-np-fold{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-caption,#9aa3b2);cursor:pointer}
.dsh-np-fold:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-seg-head{display:flex;align-items:center;gap:3px;flex:none;min-height:30px;padding:3px 5px 0 7px;box-sizing:border-box}
.dsh-np-seg[data-reorder-drag=true]{opacity:.45}
.dsh-np-seg[data-drop-before=true]{box-shadow:0 -2px 0 0 var(--np-accent)}
.dsh-np-seg[data-drop-after=true]{box-shadow:0 2px 0 0 var(--np-accent)}
.dsh-np-check{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;cursor:pointer}
.dsh-np-check input{width:14px;height:14px;margin:0;accent-color:var(--np-accent);cursor:pointer}
.dsh-np-index{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 2px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-caption,#9aa3b2);font:inherit;font-size:10px;font-weight:700;letter-spacing:.04em;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none}
.dsh-np-index:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-index[aria-pressed=true]{background:color-mix(in srgb,var(--np-accent) 14%,transparent);color:var(--np-accent)}
.dsh-np-title-input{flex:1 1 auto;min-width:0;width:0;height:20px;padding:0 4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:11px;font-weight:600;line-height:20px;outline:0}
.dsh-np-title-input::placeholder{color:var(--dsw-alias-label-caption,#9aa3b2);font-weight:400}
.dsh-np-title-input:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06))}
.dsh-np-title-input:focus{background:var(--np-surface);box-shadow:0 0 0 1px var(--np-accent) inset;color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-title-add{flex:1 1 auto;min-width:0;width:0;height:20px;padding:0 4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-caption,#9aa3b2);font:inherit;font-size:11px;font-weight:400;line-height:20px;text-align:left;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.dsh-np-seg-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px;font-weight:600}
.dsh-np-archived-chip{flex:none;padding:0 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10px;line-height:16px}
.dsh-np-segbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background .12s,color .12s,opacity .12s;opacity:.8}
.dsh-np-segbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430);opacity:1}
.dsh-np-segbtn[data-ai=true]{color:var(--np-accent);opacity:1}
.dsh-np-segbtn[data-danger=true]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#e25555);background:var(--dsw-alias-interactive-bg-hover-danger,rgb(236 19 19/.05))}
.dsh-np-segbtn:disabled{opacity:.3;cursor:default}
.dsh-np-actiongroup{display:inline-flex;align-items:center;flex:none;padding:1px;border:1px solid transparent;border-radius:8px;transition:border-color .12s ease var(--np-group-delay,.18s),background .12s ease var(--np-group-delay,.18s)}
.dsh-np-actiongroup:hover{border-color:var(--dsw-alias-border-l2,rgb(15 23 42/.14));background:color-mix(in srgb,var(--np-surface-2) 58%,transparent)}
.dsh-np-actiongroup:focus-within{border-color:var(--dsw-alias-border-l2,rgb(15 23 42/.14));background:color-mix(in srgb,var(--np-surface-2) 58%,transparent);transition-delay:0s}
.dsh-np-group-extra{width:0!important;min-width:0;padding:0;border:0;opacity:0;visibility:hidden;pointer-events:none;overflow:hidden;transition:width .14s ease var(--np-group-delay,.18s),opacity .12s ease var(--np-group-delay,.18s),visibility 0s linear var(--np-group-delay,.18s)}
.dsh-np-actiongroup:hover .dsh-np-group-extra{width:24px!important;opacity:1;visibility:visible;pointer-events:auto}
.dsh-np-actiongroup:focus-within .dsh-np-group-extra{width:24px!important;opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}
.dsh-np-actiongroup[data-size=bar]:hover .dsh-np-group-extra,.dsh-np-actiongroup[data-size=bar]:focus-within .dsh-np-group-extra{width:27px!important}
.dsh-np-actiongroup[data-expanded=true]{border-color:transparent;background:transparent}
.dsh-np-actiongroup[data-expanded=true] .dsh-np-group-extra{width:24px!important;opacity:1;visibility:visible;pointer-events:auto;transition:none}
.dsh-np-actiongroup[data-expanded=true][data-size=bar] .dsh-np-group-extra{width:27px!important}
.dsh-np-seg-text{display:block;width:100%;box-sizing:border-box;padding:2px 10px 8px;border:0;outline:0;resize:none;background:transparent;color:inherit;font-family:var(--np-font,${FONT_STACK});font-size:var(--np-font-size,13px);line-height:1.6;min-height:26px;max-height:var(--np-seg-max,240px);overflow-y:hidden;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.dsh-np-seg-text::placeholder{color:var(--dsw-alias-label-caption,#9aa3b2)}
.dsh-np-seg-text:disabled{opacity:.6}
.dsh-np-file{display:none}
.dsh-np-editor{display:flex;flex-direction:column;min-width:0;border-radius:0 0 9px 9px;transition:background .12s}
.dsh-np-editor[data-drag=true]{background:color-mix(in srgb,var(--np-accent) 8%,transparent);box-shadow:inset 0 0 0 1.5px var(--np-accent)}
.dsh-np-medias{display:flex;flex-wrap:wrap;gap:5px;padding:5px 9px 0}
.dsh-np-img{position:relative;display:inline-flex;align-items:center;gap:4px;max-width:100%;height:38px;padding:2px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:8px;background:var(--np-surface);box-shadow:0 1px 2px rgb(15 23 42/.05)}
.dsh-np-img[data-pending=true]{padding-right:6px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-np-img-open{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));overflow:hidden;cursor:zoom-in}
.dsh-np-img-open img{display:block;width:100%;height:100%;object-fit:cover}
.dsh-np-img-name{max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:13px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-np-img-remove{position:absolute;top:-6px;right:-6px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.16));border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4b5563);box-shadow:0 1px 3px rgb(15 23 42/.18);cursor:pointer;opacity:.92}
.dsh-np-img-remove:hover{background:var(--dsw-alias-state-error-primary,#e25555);border-color:transparent;color:#fff;opacity:1}
.dsh-np-img-spinner{flex:none;width:14px;height:14px;border:2px solid color-mix(in srgb,var(--np-accent) 30%,transparent);border-top-color:var(--np-accent);border-radius:50%;animation:dsh-np-spin .8s linear infinite}
.dsh-np-mini-spinner{flex:none;width:12px;height:12px;border:1.8px solid color-mix(in srgb,var(--np-accent) 30%,transparent);border-top-color:var(--np-accent);border-radius:50%;animation:dsh-np-spin .8s linear infinite}
.dsh-np-seg-archived-text{padding:2px 10px 9px;color:var(--dsw-alias-label-secondary,#4b5563);font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-np-seg[data-archived=true] .dsh-np-medias{padding:0 10px 8px}
.dsh-np-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:none;padding:22px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}
.dsh-np-empty-add{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:7px;background:var(--np-surface-2);color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:12px;cursor:pointer}
.dsh-np-empty-add:hover{color:var(--dsw-alias-label-primary,#1f2430);background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06))}
.dsh-np-empty-small{padding:8px 2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}
.dsh-np-archive{display:grid;grid-template-rows:0fr;flex:none;opacity:0;visibility:hidden;overflow:hidden;transition:grid-template-rows .22s ease,opacity .18s ease,visibility 0s linear .22s}
.dsh-np-archive[data-open=true]{grid-template-rows:1fr;opacity:1;visibility:visible;transition:grid-template-rows .22s ease,opacity .18s ease,visibility 0s linear 0s}
.dsh-np-archive-inner{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:hidden}
.dsh-np-archive-head{display:flex;align-items:center;gap:5px;padding:7px 2px 0;margin-top:2px;border-top:1px dashed var(--dsw-alias-border-l2,rgb(15 23 42/.12));color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}
.dsh-np-archive-label{font-weight:600;letter-spacing:.02em}
.dsh-np-archive-list{display:flex;flex-direction:column;gap:8px;min-height:0}
.dsh-np-link{padding:0;border:0;background:none;color:var(--dsw-alias-link,#4176e6);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.dsh-np-link:hover{text-decoration:underline}
.dsh-np-link[data-danger=true]{color:var(--dsw-alias-state-error-primary,#e25555)}
.dsh-np-foot{display:flex;align-items:center;gap:8px;flex:none;padding:6px 18px 8px 2px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10.5px;line-height:14px}
.dsh-np-status{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-np-status[data-state=error]{color:var(--dsw-alias-state-error-primary,#d94a4a)}
.dsh-np-retry{flex:none;padding:0;border:0;background:none;color:var(--dsw-alias-link,#4176e6);font:inherit;font-size:10.5px;cursor:pointer;text-decoration:underline}
.dsh-np-count{flex:none;font-variant-numeric:tabular-nums}
.dsh-np-hint{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85;font-size:10px}
button.dsh-np-hint{padding:0;border:0;background:none;color:inherit;font:inherit;font-size:10px;cursor:pointer;text-align:right}
button.dsh-np-hint:hover{opacity:1;color:var(--dsw-alias-label-secondary,#4b5563);text-decoration:underline}
.dsh-np-preview{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:44px 20px 28px;background:rgb(8 12 20/.74);backdrop-filter:blur(3px);animation:dsh-np-fade .14s ease-out}
.dsh-np-preview-img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;background:#fff;box-shadow:0 16px 40px rgb(0 0 0/.35)}
.dsh-np-preview-bar{position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:4px}
.dsh-np-preview-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid rgb(255 255 255/.18);border-radius:7px;background:rgb(15 23 42/.55);color:#f8fafc;cursor:pointer;backdrop-filter:blur(4px)}
.dsh-np-preview-btn:hover{background:rgb(15 23 42/.82)}
.dsh-np-preview-name{position:absolute;left:12px;bottom:8px;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e5e7eb;font-size:11px}
.dsh-np-confirm{position:absolute;inset:0;z-index:21;display:flex;align-items:center;justify-content:center;padding:16px;background:rgb(8 12 20/.55);backdrop-filter:blur(2px);animation:dsh-np-fade .14s ease-out}
.dsh-np-confirm-card{width:min(100%,300px);padding:14px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.14));border-radius:12px;background:var(--np-surface);box-shadow:var(--dsw-elevation-prominent,0 20px 50px rgb(15 23 42/.22))}
.dsh-np-confirm-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-confirm-body{margin-top:6px;color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;line-height:1.55}
.dsh-np-confirm-hint{margin-top:8px;color:var(--dsw-alias-state-error-primary,#e25555);font-size:11px}
.dsh-np-confirm-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:12px}
.dsh-np-confirm-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.14));border-radius:7px;background:var(--np-surface-2);color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:12px;cursor:pointer}
.dsh-np-confirm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-confirm-btn[data-danger=true]{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e25555);color:#fff}
.dsh-np-confirm-btn[data-danger=true]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e25555) 86%,#000);color:#fff}
.dsh-np-toast{position:absolute;left:50%;bottom:38px;transform:translateX(-50%);z-index:2;display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);padding:5px 10px;border-radius:8px;background:var(--np-surface-2);border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));box-shadow:var(--dsw-elevation-lv2,0 8px 24px rgb(15 23 42/.18));color:var(--dsw-alias-label-primary,#1f2430);font-size:11.5px;white-space:nowrap;overflow:hidden;animation:dsh-np-rise .16s ease-out}
.dsh-np-toast-text{overflow:hidden;text-overflow:ellipsis}
.dsh-np-toast-action{flex:none;padding:0;border:0;background:none;color:var(--dsw-alias-link,#4176e6);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;text-decoration:underline}
.dsh-np-resize{position:absolute;right:0;bottom:0;z-index:3;width:18px;height:18px;cursor:nwse-resize;color:var(--dsw-alias-label-caption,#9aa3b2);opacity:.65;touch-action:none}
.dsh-np-resize:hover{opacity:1}
.dsh-np-resize::before,.dsh-np-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;border-radius:0 0 2px 0}
.dsh-np-resize::after{right:7px;bottom:7px;width:4px;height:4px;opacity:.7}
.dsh-np-restore{position:fixed;right:16px;bottom:16px;z-index:30;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#4b5563);box-shadow:var(--dsw-elevation-lv2,0 8px 24px rgb(15 23 42/.16));cursor:pointer;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(6px) scale(.9);transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}
.dsh-np-restore[data-visible=true]{opacity:.9;visibility:visible;pointer-events:auto;transform:none;transition:opacity .18s ease,transform .18s ease,visibility 0s linear 0s}
.dsh-np-restore[data-visible=true]:hover{opacity:1;transform:translateY(-1px)}
.dsh-np-restore-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;font-size:9.5px;font-weight:700;line-height:16px;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1,#fff))}
[data-row-key^="workspace:"][data-np-unsent]{position:relative}
[data-row-key^="workspace:"][data-np-unsent]::after{content:attr(data-np-unsent);position:absolute;top:-4px;left:1px;z-index:2;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;font-size:9.5px;font-weight:700;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1,#fff))}
@keyframes dsh-np-item-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-4px) scale(.98)}}
.dsh-np-set{display:flex;flex-direction:column;gap:12px;max-width:820px;padding:2px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1f2430);--np-set-accent:var(--dsw-alias-state-business-primary,#4176e6);--np-set-tint:transparent}
.dsh-np-set[data-np-theme=ocean]{--np-set-accent:#2f6fed;--np-set-tint:#2f6fed}
.dsh-np-set[data-np-theme=violet]{--np-set-accent:#7c5cf0;--np-set-tint:#7c5cf0}
.dsh-np-set[data-np-theme=emerald]{--np-set-accent:#12986b;--np-set-tint:#12986b}
.dsh-np-set[data-np-theme=amber]{--np-set-accent:#c07a11;--np-set-tint:#f0a61f}
.dsh-np-set[data-np-theme=rose]{--np-set-accent:#d64b76;--np-set-tint:#d64b76}
.dsh-np-set-head{display:flex;flex-direction:column;gap:3px}
.dsh-np-set-title{font-size:15px;font-weight:650;line-height:1.35}
.dsh-np-set-intro{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-np-set-grid{display:flex;flex-direction:column;gap:10px}
.dsh-np-set-card{border:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08));border-radius:12px;background:color-mix(in srgb,var(--np-set-tint) 4%,var(--dsw-alias-bg-layer-1,#fff));overflow:visible}
.dsh-np-set-card-head{display:flex;align-items:center;gap:7px;padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08));font-size:12.5px;font-weight:650;line-height:1.4;background:linear-gradient(120deg,color-mix(in srgb,var(--np-set-accent) 7%,transparent),transparent 62%)}
.dsh-np-set-card-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:11px 16px;padding:11px 13px}
.dsh-np-set-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-np-set-field[data-wide=true]{grid-column:1/-1}
.dsh-np-set-label{font-size:12px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-set-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-np-set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:30px}
.dsh-np-drop{position:relative;min-width:0;width:100%}
.dsh-np-drop-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:30px;box-sizing:border-box;padding:4px 9px;border:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2430);font:inherit;font-size:12.5px;line-height:1.4;text-align:left;cursor:pointer;outline:none}
.dsh-np-drop-btn:hover{border-color:var(--dsw-alias-border-l2,rgb(15 23 42/.18))}
.dsh-np-drop-btn:focus-visible{border-color:var(--np-set-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--np-set-accent) 20%,transparent)}
.dsh-np-drop-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-np-drop-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;display:flex;flex-direction:column;gap:1px;max-height:260px;overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.14));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 14px 34px rgb(15 23 42/.22));animation:dsh-np-fade .12s ease-out}
.dsh-np-drop-item{display:flex;align-items:center;gap:6px;width:100%;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:12px;line-height:1.4;text-align:left;cursor:pointer}
.dsh-np-drop-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-drop-item[data-active=true]{color:var(--np-set-accent);background:color-mix(in srgb,var(--np-set-accent) 9%,transparent);font-weight:600}
.dsh-np-drop-check{margin-left:auto;flex:none}
.dsh-np-set-number,.dsh-np-key{width:100%;box-sizing:border-box;min-height:30px;padding:4px 9px;border:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2430);font:inherit;font-size:12.5px;outline:none}
.dsh-np-set-number:focus,.dsh-np-key:focus{border-color:var(--np-set-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--np-set-accent) 18%,transparent)}
.dsh-np-set-number:disabled,.dsh-np-key:disabled{opacity:.45;cursor:default}
.dsh-np-key{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);cursor:text;letter-spacing:.02em}
.dsh-np-set-textarea{width:100%;box-sizing:border-box;min-height:92px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2430);font:inherit;font-size:12.5px;line-height:1.55;resize:vertical;outline:none}
.dsh-np-set-textarea:focus{border-color:var(--np-set-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--np-set-accent) 18%,transparent)}
.dsh-np-set-textarea[data-readonly=true]{background:var(--dsw-alias-bg-layer-2,#f7f7f9);color:var(--dsw-alias-label-secondary,#4b5563);cursor:default}
.dsh-np-toggle{display:inline-flex;align-items:center;gap:9px;padding:3px 11px 3px 4px;border:1px solid transparent;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer;outline:none}
.dsh-np-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06))}
.dsh-np-toggle:focus-visible{outline:2px solid var(--np-set-accent);outline-offset:1px}
.dsh-np-toggle-track{position:relative;display:inline-block;flex:none;width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l3,rgb(15 23 42/.2));transition:background .15s ease}
.dsh-np-toggle.on .dsh-np-toggle-track{background:var(--np-set-accent)}
.dsh-np-toggle-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgb(0 0 0/.25);transition:transform .15s ease}
.dsh-np-toggle.on .dsh-np-toggle-knob{transform:translateX(16px)}
.dsh-np-toggle-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap}
.dsh-np-toggle.on .dsh-np-toggle-label{color:var(--dsw-alias-label-primary,#1f2430);font-weight:600}
.dsh-np-set-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-np-set-btn{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 11px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.14));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2430);font:inherit;font-size:12px;cursor:pointer}
.dsh-np-set-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06))}
.dsh-np-set-btn[data-primary=true]{border-color:transparent;background:var(--np-set-accent);color:#fff}
.dsh-np-set-btn[data-danger=true]{color:var(--dsw-alias-state-error-primary,#e25555)}
.dsh-np-set-note{padding:0 13px 11px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-np-set-kbd{display:inline-block;padding:0 5px;border:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.12));border-radius:4px;background:var(--dsw-alias-bg-layer-2,#fff);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:10.5px;line-height:16px}
body[data-ds-dark-theme] .dsh-np-set-card,body[data-ds-dark-theme] .dsh-np-drop-btn,body[data-ds-dark-theme] .dsh-np-drop-menu,body[data-ds-dark-theme] .dsh-np-set-number,body[data-ds-dark-theme] .dsh-np-key,body[data-ds-dark-theme] .dsh-np-set-textarea,body[data-ds-dark-theme] .dsh-np-set-btn{background:color-mix(in srgb,var(--np-set-tint) 5%,var(--dsw-alias-bg-layer-1,#1f1f22));color:var(--dsw-alias-label-primary,#e8e8ea)}
body[data-ds-dark-theme] .dsh-np-set-hint,body[data-ds-dark-theme] .dsh-np-set-intro,body[data-ds-dark-theme] .dsh-np-toggle-label{color:var(--dsw-alias-label-secondary,#a8adb8)}
body[data-ds-dark-theme] .dsh-np-set-textarea[data-readonly=true]{background:color-mix(in srgb,var(--np-set-tint) 3%,var(--dsw-alias-bg-layer-2,#252528));color:var(--dsw-alias-label-secondary,#a8adb8)}
body[data-ds-dark-theme] .dsh-np-toggle-knob{background:#f4f5f7}
body[data-ds-dark-theme] .dsh-np-ws-menu{background:var(--dsw-alias-bg-layer-1,#1f1f22)}
@keyframes dsh-np-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dsh-np-fade{from{opacity:0}to{opacity:1}}
@keyframes dsh-np-rise{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes dsh-np-item-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@keyframes dsh-np-spin{to{transform:rotate(360deg)}}
body[data-ds-dark-theme] .dsh-np-card{--np-accent-fg:#0f1115;box-shadow:0 18px 48px rgb(0 0 0/.55),0 0 0 .5px rgb(255 255 255/.07)}
body[data-ds-dark-theme] .dsh-np-seg[data-selected=true]{background:color-mix(in srgb,var(--np-accent) 14%,var(--dsw-alias-bg-layer-2,#2c2c2e))}
body[data-ds-dark-theme] .dsh-np-btn[data-accent=true]:hover:not(:disabled){background:color-mix(in srgb,var(--np-accent) 84%,#fff)}
body[data-ds-dark-theme] .dsh-np-seg[data-archived=true]{opacity:.7}
@media (prefers-reduced-motion:reduce){.dsh-np-card,.dsh-np-body,.dsh-np-archive,.dsh-np-restore,.dsh-np-seg,.dsh-np-toast,.dsh-np-actiongroup,.dsh-np-group-extra,.dsh-np-preview,.dsh-np-confirm{transition:none!important;animation:none!important}.dsh-np-dot[data-state=saving]{animation:none}.dsh-np-img-spinner,.dsh-np-mini-spinner{animation:none}}`;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    let segmentSequence = 0;

    function newSegmentId() {
      const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
      if (cryptoObject !== undefined && typeof cryptoObject.randomUUID === 'function') {
        try {
          return cryptoObject.randomUUID();
        } catch {
          /* fall through */
        }
      }
      segmentSequence += 1;
      return `seg-${Date.now().toString(36)}-${segmentSequence.toString(36)}`;
    }

    function nowIso() {
      try {
        return new Date().toISOString();
      } catch {
        return '';
      }
    }

    /** Content identity used by archive de-duplication (line endings / edges only). */
    function contentKey(text) {
      return String(text ?? '').replace(/\r\n?/gu, '\n').trim();
    }

    /** Normalize one archive source; unknown values become the legacy manual origin. */
    function archiveOriginOf(value) {
      return typeof value === 'string' && ARCHIVE_ORIGIN_SET.has(value) ? value : null;
    }

    /**
     * Install one process-wide around-hook on the conversation service so a
     * successful composer send can be mirrored into the workspace archive.
     * The host exposes no send event, and sendSession is the single path every
     * ordinary composer message takes. The hook stores its state on the
     * service itself so a plugin reload reuses it instead of wrapping twice.
     * @param {any} ctx plugin context
     * @returns {{listeners: Set<(session: any, text: string) => void>} | null}
     */
    function installComposerSendPatch(ctx) {
      let conversation;
      try {
        conversation = ctx?.get?.('conversation');
      } catch {
        conversation = undefined;
      }
      if (conversation === null || conversation === undefined
        || typeof conversation.sendSession !== 'function') return null;
      const existing = conversation[COMPOSER_PATCH_KEY];
      if (existing !== null && existing !== undefined && existing.listeners instanceof Set) return existing;
      const original = conversation.sendSession;
      const state = { listeners: new Set() };
      const wrapped = async function sendSessionPatched(...args) {
        const outcome = await original.apply(this, args);
        const text = args[1];
        if (outcome?.kind === 'success' && typeof text === 'string' && text.trim() !== '') {
          for (const listener of [...state.listeners]) {
            try {
              const result = listener(args[0], text);
              if (result !== null && result !== undefined && typeof result.catch === 'function') {
                result.catch((error) => {
                  console.warn('[dsh-notepad] archive-after-send failed:', error?.message ?? error);
                });
              }
            } catch (error) {
              console.warn('[dsh-notepad] archive-after-send failed:', error?.message ?? error);
            }
          }
        }
        return outcome;
      };
      try {
        Object.defineProperty(conversation, 'sendSession', {
          configurable: true,
          writable: true,
          value: wrapped,
        });
        Object.defineProperty(conversation, COMPOSER_PATCH_KEY, {
          configurable: true,
          writable: true,
          value: state,
        });
      } catch {
        return null;
      }
      return state;
    }

    function newSegment(text, options = {}) {
      return {
        id: newSegmentId(),
        text,
        title: typeof options.title === 'string' ? options.title.slice(0, MAX_TITLE_CHARS) : '',
        createdAt: typeof options.createdAt === 'string' && options.createdAt !== ''
          ? options.createdAt
          : nowIso(),
        images: [],
        archived: false,
        archivedAt: null,
        origin: null,
      };
    }

    function serializeSegments(segments) {
      return segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        ...(typeof segment.title === 'string' && segment.title !== ''
          ? { title: segment.title }
          : {}),
        ...(typeof segment.createdAt === 'string' && segment.createdAt !== ''
          ? { createdAt: segment.createdAt }
          : {}),
        ...(Array.isArray(segment.images) && segment.images.length > 0
          ? { images: segment.images.map((image) => ({ path: image.path, name: image.name })) }
          : {}),
        ...(segment.archived === true ? { archived: true } : {}),
        ...(segment.archived === true && typeof segment.archivedAt === 'string' ? { archivedAt: segment.archivedAt } : {}),
        ...(segment.archived === true && archiveOriginOf(segment.origin) !== null
          ? { origin: archiveOriginOf(segment.origin) }
          : {}),
      }));
    }

    function normalizeServerSegments(data) {
      if (Array.isArray(data?.segments)) {
        const seen = new Set();
        const out = [];
        for (const item of data.segments) {
          if (item === null || typeof item !== 'object' || typeof item.text !== 'string') continue;
          let id = typeof item.id === 'string' && item.id !== '' ? item.id : newSegmentId();
          while (seen.has(id)) id = newSegmentId();
          seen.add(id);
          const archived = item.archived === true;
          out.push({
            id,
            text: item.text,
            title: typeof item.title === 'string' ? item.title.slice(0, MAX_TITLE_CHARS) : '',
            createdAt: typeof item.createdAt === 'string' && item.createdAt !== '' ? item.createdAt : null,
            images: normalizeImages(item.images),
            archived,
            archivedAt: archived && typeof item.archivedAt === 'string' ? item.archivedAt : null,
            origin: archived ? archiveOriginOf(item.origin) : null,
          });
        }
        return out;
      }
      const text = typeof data?.text === 'string' ? data.text : '';
      return text === '' ? [] : [newSegment(text)];
    }

    function baseNameOf(value) {
      const trimmed = String(value ?? '').replace(/[/\\]+$/u, '');
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return trimmed.slice(separator + 1);
    }

    function normalizeImage(value) {
      if (typeof value === 'string') value = { path: value };
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      if (typeof value.path !== 'string') return null;
      const filePath = value.path.trim().replace(/\\/gu, '/');
      if (filePath === '') return null;
      const rawName = typeof value.name === 'string' && value.name.trim() !== ''
        ? value.name.trim().replace(/\s+/gu, ' ')
        : baseNameOf(filePath);
      return { path: filePath, name: rawName === '' ? 'image' : rawName.slice(0, 160) };
    }

    function normalizeImages(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const item of value) {
        if (out.length >= MAX_IMAGES) break;
        const image = normalizeImage(item);
        if (image !== null) out.push(image);
      }
      return out;
    }

    /** Markdown reference used in the note body and composer transfers. */
    function imageMarkdown(image) {
      const file = typeof image?.path === 'string' ? image.path.replace(/\\/gu, '/') : '';
      if (file === '') return '';
      const label = (typeof image?.name === 'string' ? image.name : '')
        .replace(/[\r\n]+/gu, ' ')
        .replace(/[[\]]/gu, ' ')
        .trim() || baseNameOf(file) || 'image';
      let target;
      try {
        target = encodeURI(file);
      } catch {
        target = file;
      }
      target = target
        .replace(/#/gu, '%23')
        .replace(/\?/gu, '%3F')
        .replace(/\(/gu, '%28')
        .replace(/\)/gu, '%29');
      return `![${label}](${target})`;
    }

    /** One segment as text plus one Markdown line per attached image. */
    function segmentBody(segment) {
      if (segment === null || segment === undefined) return '';
      const text = typeof segment.text === 'string' ? segment.text : '';
      const images = Array.isArray(segment.images) ? segment.images : [];
      const parts = [];
      if (text.trim() !== '') parts.push(text);
      for (const image of images) {
        const markdown = imageMarkdown(image);
        if (markdown !== '') parts.push(markdown);
      }
      return parts.join('\n');
    }

    function mergedText(segments) {
      return segments
        .map((segment) => segmentBody(segment))
        .filter((text) => text !== '')
        .join('\n\n');
    }

    /** Whether a segment still counts as unsent work (active + has content). */
    function isUnsent(segment) {
      if (segment === null || segment === undefined || segment.archived === true) return false;
      if (typeof segment.text === 'string' && segment.text.trim() !== '') return true;
      return Array.isArray(segment.images) && segment.images.length > 0;
    }

    function countUnsent(segments) {
      let count = 0;
      for (const segment of segments) {
        if (isUnsent(segment)) count += 1;
      }
      return count;
    }

    /** A segment with no title, text, or images can be deleted without a prompt. */
    function isEmptySegment(segment) {
      if (segment === null || segment === undefined) return false;
      const title = typeof segment.title === 'string' ? segment.title.trim() : '';
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      const images = Array.isArray(segment.images) ? segment.images : [];
      return title === '' && text === '' && images.length === 0;
    }

    /** Merge image references in order, dropping duplicates and respecting the cap. */
    function collectImages(segments) {
      const seen = new Set();
      const images = [];
      for (const segment of segments) {
        for (const image of Array.isArray(segment?.images) ? segment.images : []) {
          if (seen.has(image.path) || images.length >= MAX_IMAGES) continue;
          seen.add(image.path);
          images.push(image);
        }
      }
      return images;
    }

    /**
     * Decode a GET /note payload. Version 4 (0.4–0.6) stored newest-first;
     * version 5 stores oldest-first, so a v4 list is reversed once for display.
     */
    function readServerSegments(data) {
      let value = normalizeServerSegments(data);
      if (data?.version === 4) value = value.slice().reverse();
      return value;
    }

    /**
     * Adopt server content without moving cards the user is looking at.
     * Known ids keep the local order; cards created elsewhere land at the
     * bottom, matching the oldest-to-newest display direction.
     */
    function mergeServerOrder(current, incoming) {
      const byId = new Map();
      for (const segment of incoming) byId.set(segment.id, segment);
      const kept = [];
      for (const segment of current) {
        const next = byId.get(segment.id);
        if (next !== undefined) kept.push(next);
      }
      const known = new Set(kept.map((segment) => segment.id));
      const added = incoming.filter((segment) => !known.has(segment.id));
      return [...kept, ...added];
    }

    function isAbsolutePath(value) {
      const text = String(value ?? '');
      return text.startsWith('/') || /^[A-Za-z]:\//u.test(text) || text.startsWith('//');
    }

    function normalizedCwd(value) {
      return String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '');
    }

    /** Comparison key for one directory: drive / UNC paths ignore case. */
    function workspacePathKey(value) {
      const text = normalizedCwd(value);
      return /^[A-Za-z]:\//u.test(text) || text.startsWith('//') ? text.toLowerCase() : text;
    }

    /**
     * Resolve the registered Workspace that owns a Session.
     *
     * The Session's Workspace membership is authoritative: the same directory
     * can be spelled several ways (drive case, junction, mapped drive), and a
     * plain string compare used to leave the live sidebar badge without a
     * Workspace id — it then only caught up on the slow polling refresh.
     *
     * @param ctx - plugin context; the Workspace projection is read when open.
     * @param cwd - working directory of the Session the note reads.
     * @param sessionId - the Session; its membership wins over a path match.
     * @param candidates - Workspace registry rows from the counts response.
     * @returns the Workspace id, or '' when no Workspace claims the Session.
     */
    function resolveWorkspaceId(ctx, cwd, sessionId, candidates) {
      const target = workspacePathKey(cwd);
      const list = Array.isArray(candidates) ? candidates : [];
      let items = [];
      try {
        const snapshot = ctx?.get?.('workspaces')?.list?.getSnapshot?.();
        if (Array.isArray(snapshot?.items)) items = snapshot.items;
      } catch {
        /* The Workspace projection may still be opening. */
      }
      if (typeof sessionId === 'string' && sessionId !== '') {
        const member = items.find((item) =>
          Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId));
        if (typeof member?.workspaceId === 'string' && member.workspaceId !== '') return member.workspaceId;
      }
      if (target !== '') {
        const projected = items.find((item) =>
          typeof item?.workspaceId === 'string' && item.workspaceId !== ''
          && item?.path !== undefined && workspacePathKey(item.path) === target);
        if (projected !== undefined) return projected.workspaceId;
        const registered = list.find((item) =>
          typeof item?.id === 'string' && item.id !== ''
          && item?.path !== undefined && workspacePathKey(item.path) === target);
        if (registered !== undefined) return registered.id;
      }
      return '';
    }

    /**
     * Badge refreshers of every mounted notepad view. A save in one Session
     * changes counts that other Sessions' sidebar rows show, so they are
     * woken up instead of waiting for the polling refresh.
     */
    const badgeRefreshers = new Set();

    function requestBadgeRefresh() {
      for (const refresh of [...badgeRefreshers]) {
        try {
          refresh();
        } catch {
          /* One broken view must not stop the others. */
        }
      }
    }

    /** Store a path relative to the workspace when it lives inside it. */
    function imagePathForNote(pathValue, cwd) {
      const file = String(pathValue ?? '').replace(/\\/gu, '/');
      const root = normalizedCwd(cwd);
      if (root === '') return file;
      // Windows drive / UNC spellings are case-insensitive; POSIX ones are not.
      const windows = /^[A-Za-z]:\//u.test(root) || root.startsWith('//');
      const compareFile = windows ? file.toLowerCase() : file;
      const compareRoot = windows ? root.toLowerCase() : root;
      if (compareFile === compareRoot) return '.';
      if (compareFile.startsWith(`${compareRoot}/`)) return file.slice(root.length + 1);
      return file;
    }

    function absoluteImagePath(pathValue, cwd) {
      const file = String(pathValue ?? '').replace(/\\/gu, '/');
      if (isAbsolutePath(file)) return file;
      const root = normalizedCwd(cwd);
      return root === '' ? file : `${root}/${file.replace(/^\/+/u, '')}`;
    }

    /** Authenticated host file route used by the browser image renderer. */
    function imageUrl(pathValue, cwd) {
      const target = absoluteImagePath(pathValue, cwd);
      try {
        const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
          ? document.baseURI
          : 'http://localhost/';
        const url = new URL('api/file', base);
        url.searchParams.set('path', target);
        return url.href;
      } catch {
        return `/api/file?path=${encodeURIComponent(target)}`;
      }
    }

    function imageMimeOf(file) {
      const type = typeof file?.type === 'string' ? file.type.toLowerCase() : '';
      if (type !== '') return Object.prototype.hasOwnProperty.call(IMAGE_MIME, type) ? type : '';
      const name = String(file?.name ?? '');
      if (/\.png$/iu.test(name)) return 'image/png';
      if (/\.jpe?g$/iu.test(name)) return 'image/jpeg';
      if (/\.webp$/iu.test(name)) return 'image/webp';
      if (/\.gif$/iu.test(name)) return 'image/gif';
      return '';
    }

    function isSupportedImage(file) {
      return imageMimeOf(file) !== '';
    }

    function hostPathOf(file) {
      try {
        const bridge = globalThis.__DSH_HOST_PATHS__;
        if (bridge === null || bridge === undefined || typeof bridge.pathFor !== 'function') return '';
        const value = bridge.pathFor(file);
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    }

    class ImageError extends Error {
      constructor(code, message) {
        super(message ?? code);
        this.name = 'ImageError';
        this.code = code;
      }
    }

    function readFileBase64(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new FileReader();
          reader.onerror = () => reject(new ImageError('read-failed', 'Could not read the image file.'));
          reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
          };
          reader.readAsDataURL(file);
        } catch (error) {
          reject(error);
        }
      });
    }

    async function uploadImage(root, sessionId, file) {
      if (Number(file?.size) > MAX_IMAGE_BYTES) throw new ImageError('too-large');
      const mime = imageMimeOf(file);
      if (mime === '') throw new ImageError('unsupported');
      const data = await readFileBase64(file);
      const response = await fetch(`${API}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root,
          sessionId,
          name: typeof file?.name === 'string' && file.name !== '' ? file.name : 'image.png',
          mime,
          data,
        }),
      });
      const payload = await readResponse(response);
      const image = normalizeImage(payload);
      if (image === null) throw new ImageError('upload-failed', 'The host did not return an image path.');
      return image;
    }

    function autoGrow(element, maxHeight = MAX_SEGMENT_HEIGHT) {
      if (element === null || element === undefined || element.style === undefined) return;
      const limit = clampInt(maxHeight, 80, 800, MAX_SEGMENT_HEIGHT);
      try {
        element.style.height = 'auto';
        const height = Number(element.scrollHeight);
        if (Number.isFinite(height) && height > 0) {
          const capped = height > limit;
          element.style.height = `${Math.min(limit, Math.max(26, height))}px`;
          // Keep the native scrollbar hidden until the card really reaches
          // its limit; otherwise CSS overflow:auto can reserve a gutter early.
          element.style.overflowY = capped ? 'auto' : 'hidden';
        }
      } catch {
        /* A non-layout shim (tests) may not expose scrollHeight. */
      }
    }

    function workspaceName(root) {
      const parts = String(root ?? '').split(/[\\/]+/u).filter(Boolean);
      return parts.length === 0 ? String(root ?? '') : parts[parts.length - 1];
    }

    /**
     * Height of the chrome the host draws over the page (the Windows title bar
     * with maximize / minimize / close, or the macOS traffic lights). The
     * floating card must never move above that strip. The host exposes it as a
     * CSS variable on <html>; standalone browsers have none, so this is 0.
     * @returns {number}
     */
    function hostChromeTop() {
      try {
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        if (root === null || root === undefined) return 0;
        const hasAttribute = (name) => typeof root.hasAttribute === 'function' && root.hasAttribute(name);
        const readVar = (name) => {
          try {
            if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return NaN;
            const style = window.getComputedStyle(root);
            return Number.parseFloat(style?.getPropertyValue(name) ?? '');
          } catch {
            return NaN;
          }
        };
        // `--dsh-frame-chrome-top` is 0 while the host is in fullscreen.
        const chrome = readVar('--dsh-frame-chrome-top');
        if (Number.isFinite(chrome)) return Math.max(0, chrome);
        const clearance = readVar('--dsh-frame-top-clearance');
        if (Number.isFinite(clearance) && clearance > 0) return clearance;
        if (hasAttribute('data-windows-titlebar')) {
          const titlebar = readVar('--dsh-windows-titlebar-height');
          return Number.isFinite(titlebar) && titlebar > 0 ? titlebar : 32;
        }
        const platform = typeof root.getAttribute === 'function' ? root.getAttribute('data-platform') : '';
        return platform === 'darwin' ? 48 : 0;
      } catch {
        return 0;
      }
    }

    function readStoredUi() {
      const settings = readSettings();
      const base = {
        x: settings.defaultX,
        y: settings.defaultY,
        width: settings.defaultWidth,
        height: settings.defaultHeight,
        minimized: false,
        hidden: false,
        showArchive: false,
      };
      try {
        const raw = window.localStorage?.getItem(UI_KEY);
        if (typeof raw !== 'string' || raw === '') return base;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return base;
        return {
          x: Number.isFinite(parsed.x) ? parsed.x : settings.defaultX,
          y: Number.isFinite(parsed.y) ? parsed.y : settings.defaultY,
          width: Number.isFinite(parsed.width) ? parsed.width : settings.defaultWidth,
          height: Number.isFinite(parsed.height) ? parsed.height : settings.defaultHeight,
          minimized: parsed.minimized === true,
          hidden: parsed.hidden === true,
          showArchive: parsed.showArchive === true,
        };
      } catch {
        return base;
      }
    }

    function clampUi(ui) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const minTop = hostChromeTop() + EDGE_GAP;
      const widthLimit = Math.max(240, vw - EDGE_GAP * 2);
      const heightLimit = Math.max(180, vh - minTop - EDGE_GAP);
      const width = Math.min(Math.max(MIN_W, Number(ui.width) || DEFAULT_W), widthLimit);
      const height = Math.min(Math.max(MIN_H, Number(ui.height) || DEFAULT_H), heightLimit);
      const displayHeight = ui.minimized ? HEAD_H : height;
      const x = ui.x === null || ui.x === undefined
        ? Math.max(EDGE_GAP, vw - width - 24)
        : Math.min(Math.max(EDGE_GAP, ui.x), Math.max(EDGE_GAP, vw - width - EDGE_GAP));
      const y = ui.y === null || ui.y === undefined
        ? Math.max(minTop, vh - displayHeight - 24)
        : Math.min(Math.max(minTop, ui.y), Math.max(minTop, vh - displayHeight - EDGE_GAP));
      return { ...ui, x, y, width, height };
    }

    async function readResponse(response) {
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      return data;
    }

    async function fetchNote(root, sessionId) {
      const query = new URLSearchParams({ root, sessionId });
      const response = await fetch(`${API}/note?${query.toString()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      return readResponse(response);
    }

    async function saveNote(root, sessionId, segments) {
      const response = await fetch(`${API}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, sessionId, segments }),
      });
      return readResponse(response);
    }

    async function optimizeNoteText(root, sessionId, text, title, signature) {
      const response = await fetch(`${API}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, sessionId, text, title, system: signature }),
      });
      return readResponse(response);
    }

    async function removeStoredImage(root, sessionId, pathValue) {
      const response = await fetch(`${API}/image`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, sessionId, path: pathValue }),
      });
      return readResponse(response);
    }

    async function fetchUnsentCounts(sessionId) {
      const response = await fetch(`${API}/unsent?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        cache: 'no-store',
      });
      return readResponse(response);
    }

    async function copyText(value) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        /* fall through to execCommand */
      }
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        area.style.top = '0';
        document.body.appendChild(area);
        area.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }

    function clockLabel(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function presentConversation() {
      try {
        if (typeof document === 'undefined') return false;
        const node = document.querySelector('[data-conversation-content]');
        if (node === null || node === undefined) return false;
        if (typeof node.getBoundingClientRect === 'function') {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        return true;
      } catch {
        return false;
      }
    }

    /** Mounted notepads register here so a host shortcut can reset them. */
    const resetHandlers = new Set();

    /** Mounted notepads register their visibility / history / save entry points. */
    const visibilityHandlers = new Set();
    const historyHandlers = new Set();
    const saveHandlers = new Set();
    const geometryHandlers = new Set();

    /** Whether the host shortcut service already owns the registered chords. */
    const hostHandledShortcuts = new Set();

    function invokeHandlers(handlers, argument) {
      let handled = false;
      for (const handler of handlers) {
        try {
          handler(argument);
          handled = true;
        } catch {
          /* One failing overlay must not block the others. */
        }
      }
      return handled;
    }

    /** Ask every mounted notepad to reset its position and size. */
    function requestUiReset() {
      return invokeHandlers(resetHandlers);
    }

    /** Ask every mounted notepad to show / hide itself. */
    function requestToggleVisibility() {
      return invokeHandlers(visibilityHandlers);
    }

    /** Ask every mounted notepad to undo or redo one plugin history step. */
    function requestHistory(direction) {
      return invokeHandlers(historyHandlers, direction);
    }

    /** Ask every mounted notepad to flush its note to disk now. */
    function requestSaveNote() {
      return invokeHandlers(saveHandlers);
    }

    /** Read the current floating-window geometry from the mounted overlay. */
    function requestGeometrySnapshot() {
      for (const handler of geometryHandlers) {
        try {
          const value = handler();
          if (value !== null && value !== undefined) return value;
        } catch {
          /* Try the next overlay. */
        }
      }
      return null;
    }

    /**
     * Reset geometry from a surface that may render before the floating
     * notepad mounts (the settings tab). The mounted overlay wins; without
     * one the stored geometry is rewritten for the next mount.
     */
    function resetWindowGeometry() {
      if (requestUiReset()) return true;
      try {
        const settings = readSettings();
        const base = readStoredUi();
        const next = {
          ...base,
          x: settings.defaultX,
          y: settings.defaultY,
          width: settings.defaultWidth,
          height: settings.defaultHeight,
        };
        window.localStorage?.setItem(UI_KEY, JSON.stringify(next));
      } catch {
        /* Storage may be unavailable; the next mount still uses defaults. */
      }
      return false;
    }

    /** Read the General Settings "send behavior while busy" preference. */
    function busyEnterPreference(ctx) {
      try {
        const forms = ctx.get('configForms') ?? ctx.configForms;
        const form = typeof forms?.get === 'function' ? forms.get('ui-conversation') : undefined;
        const value = form?.getSnapshot?.()?.value;
        return value?.busyEnter === 'steer' ? 'steer' : 'queue';
      } catch {
        return 'queue';
      }
    }

    // ------------------------------------------------------------------
    // Overlay
    // ------------------------------------------------------------------

    /**
     * @param {{ ctx: any, t: (key: string, params?: Record<string, unknown>) => string }} props
     */
    function NotepadOverlay({ ctx, t }) {
      const [binding, setBinding] = useState(null);
      const [present, setPresent] = useState(presentConversation);
      const [segments, setSegments] = useState([]);
      const [selected, setSelected] = useState(() => new Set());
      const [status, setStatus] = useState('idle');
      const [error, setError] = useState('');
      const [savedAt, setSavedAt] = useState(null);
      const [toast, setToast] = useState(null);
      const [ui, setUi] = useState(() => clampUi(readStoredUi()));
      const [sending, setSending] = useState(false);
      const [resizing, setResizing] = useState(false);
      const [uploading, setUploading] = useState({});
      const [dragSegment, setDragSegment] = useState('');
      const [reorderDrag, setReorderDrag] = useState('');
      const [reorderOver, setReorderOver] = useState(null);
      const [optimizing, setOptimizing] = useState(() => new Set());
      const [optimizeBatch, setOptimizeBatch] = useState(null);
      const [segmentUndo, setSegmentUndo] = useState(() => new Map());
      const [batchUndo, setBatchUndo] = useState(null);
      const [titleEditing, setTitleEditing] = useState('');
      const [previewImage, setPreviewImage] = useState(null);
      const [deleteConfirm, setDeleteConfirm] = useState('');
      const [hintIndex, setHintIndex] = useState(0);
      const [wsCounts, setWsCounts] = useState({});
      const [currentWsId, setCurrentWsId] = useState('');
      const [wsList, setWsList] = useState([]);
      const [wsOpen, setWsOpen] = useState(false);
      const [settings, setSettings] = useState(readSettings);
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [textSelection, setTextSelection] = useState(null);
      const [leaving, setLeaving] = useState(() => new Map());
      const [historyVer, setHistoryVer] = useState(0);

      const bindingRef = useRef(null);
      const rootSessionRef = useRef('');
      const segmentsRef = useRef([]);
      const selectedRef = useRef(selected);
      const rootRef = useRef('');
      const versionRef = useRef(null);
      const dirtyRef = useRef(false);
      const timerRef = useRef(0);
      const toastTimerRef = useRef(0);
      const seqRef = useRef(0);
      const saveNowRef = useRef(null);
      const reloadRef = useRef(null);
      const loadFailedRef = useRef(false);
      const loadSeqRef = useRef(0);
      const inputActionsRef = useRef(null);
      /** Live composer input store (`hooks.input`): the only way to read the draft text. */
      const inputStateRef = useRef(null);
      const dragRef = useRef(null);
      const resizeRef = useRef(null);
      const sendingRef = useRef(false);
      const textareaRefs = useRef(new Map());
      const fileInputRefs = useRef(new Map());
      const listRef = useRef(null);
      const pendingFocusRef = useRef(null);
      const pendingScrollRef = useRef(null);
      const refreshSeqRef = useRef(0);
      const undoRef = useRef(null);
      const optimizingRef = useRef(new Set());
      const optimizeBatchRef = useRef(false);
      const optimizeCacheRef = useRef(new Map());
      const batchUndoRef = useRef(null);
      const reorderDragRef = useRef('');
      const reorderOverRef = useRef(null);
      const imageDeleteTimersRef = useRef(new Map());
      const settingsRef = useRef(settings);
      const collapsedRef = useRef(collapsed);
      const uiRef = useRef(ui);
      const textSelectionRef = useRef(null);
      const pendingSelectionRef = useRef(null);
      const growAllRef = useRef(false);
      const historyRef = useRef({ entries: [], index: 0 });
      const historyRootRef = useRef('');
      const historyApplyingRef = useRef(false);
      const textHistoryRef = useRef(null);
      const leaveTimersRef = useRef(new Set());
      const leavingIdsRef = useRef(new Set());
      const archiveListRef = useRef(null);
      const wsWrapRef = useRef(null);
      const textareaSettersRef = useRef(new Map());
      const fileInputSettersRef = useRef(new Map());
      /** True only while the current workspace note has finished its first load. */
      const loadedRef = useRef(false);
      /** Archive ids whose initial folded state has already been decided. */
      const collapseSeenRef = useRef(new Set());
      /** Latest chat-send archive handler (the installed hook must see current state). */
      const composerSendRef = useRef(null);

      settingsRef.current = settings;
      collapsedRef.current = collapsed;
      uiRef.current = ui;

      const setSelection = (next) => {
        selectedRef.current = next;
        setSelected(next);
      };

      const setTextSelectionState = (next) => {
        textSelectionRef.current = next;
        setTextSelection(next);
      };

      const syncCollapsed = (next) => {
        collapsedRef.current = next;
        setCollapsed(next);
      };

      /**
       * Decide the initial folded state for archive cards the current view has
       * not seen yet. Auto-saved conversation messages start collapsed; manual
       * archives, sent notepad segments and legacy cards start expanded.
       * @param {Array<any>} list
       */
      const applyArchiveCollapseDefaults = (list) => {
        const next = new Set(collapsedRef.current);
        let changed = false;
        for (const segment of list) {
          if (segment?.archived !== true) continue;
          if (collapseSeenRef.current.has(segment.id)) continue;
          collapseSeenRef.current.add(segment.id);
          if (segment.origin === ARCHIVE_ORIGIN.compose && !next.has(segment.id)) {
            next.add(segment.id);
            changed = true;
          }
        }
        if (changed) syncCollapsed(next);
      };

      /**
       * Apply the requested default visibility for newly archived ids.
       * @param {Iterable<string>} ids
       * @param {'manual' | 'send' | 'compose'} origin
       */
      const setArchiveCollapse = (ids, origin) => {
        const next = new Set(collapsedRef.current);
        for (const id of ids) {
          collapseSeenRef.current.add(id);
          if (origin === ARCHIVE_ORIGIN.compose) next.add(id);
          else next.delete(id);
        }
        syncCollapsed(next);
      };

      /** Forget folded state for ids that leave the archive. */
      const forgetArchiveCollapse = (ids) => {
        const next = new Set(collapsedRef.current);
        for (const id of ids) {
          collapseSeenRef.current.delete(id);
          next.delete(id);
        }
        syncCollapsed(next);
      };

      /** Changes whenever the archived set/order changes (archive auto-scroll). */
      const archivedSignature = segments
        .filter((segment) => segment.archived === true)
        .map((segment) => segment.id)
        .join('|');

      const pruneSelectionFor = (nextSegments) => {
        if (selectedRef.current.size === 0) return;
        const activeIds = new Set(nextSegments.filter((segment) => segment.archived !== true).map((segment) => segment.id));
        const pruned = new Set();
        let changed = false;
        for (const id of selectedRef.current) {
          if (activeIds.has(id)) pruned.add(id);
          else changed = true;
        }
        if (changed) setSelection(pruned);
      };

      /** Keep the ref and the state in sync for the batch-optimize undo slot. */
      const setBatchUndoState = (value) => {
        batchUndoRef.current = value;
        setBatchUndo(value);
      };

      /** Any local edit invalidates the "undo the last batch" offer. */
      const invalidateBatchUndo = () => {
        if (batchUndoRef.current !== null) setBatchUndoState(null);
      };

      // Undo / redo history -------------------------------------------------
      const resetHistory = () => {
        if (textHistoryRef.current !== null && textHistoryRef.current.timer) {
          clearTimeout(textHistoryRef.current.timer);
        }
        textHistoryRef.current = null;
        historyRef.current = { entries: [], index: 0 };
        setHistoryVer((version) => version + 1);
      };

      const recordHistory = (before, after) => {
        if (historyApplyingRef.current) return;
        const signatureBefore = JSON.stringify(serializeSegments(before));
        const signatureAfter = JSON.stringify(serializeSegments(after));
        if (signatureBefore === signatureAfter) return;
        pushHistoryEntry({ before, after });
      };

      /** Append one undo step, discarding the redo tail and trimming to the limit. */
      const pushHistoryEntry = (entry) => {
        const state = historyRef.current;
        // A new branch discards the redo tail.
        if (state.index < state.entries.length) state.entries = state.entries.slice(0, state.index);
        state.entries.push(entry);
        const limit = clampInt(settingsRef.current.undoLimit, 5, 200, 50);
        if (state.entries.length > limit) state.entries.splice(0, state.entries.length - limit);
        state.index = state.entries.length;
        setHistoryVer((version) => version + 1);
      };

      /** Current composer draft text, or null when the live input store is unavailable. */
      const readDraftText = () => {
        const store = inputStateRef.current;
        if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return null;
        try {
          const snapshot = store.getSnapshot();
          return typeof snapshot?.draft === 'string' ? snapshot.draft : null;
        } catch {
          return null;
        }
      };

      /**
       * Record a composer insert / replace as its own undo step. The composer
       * keeps native undo for typing, but a programmatic insert / setDraft does
       * not survive as one reversible step there, so the plugin history owns it.
       */
      const recordComposerHistory = (before, after) => {
        if (historyApplyingRef.current) return;
        if (typeof before !== 'string' || typeof after !== 'string' || before === after) return;
        const sessionId = bindingRef.current?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return;
        pushHistoryEntry({ kind: 'composer', sessionId, before, after });
      };

      /**
       * Restore one composer step. The step only applies while the composer
       * still holds the draft the step produced; a draft edited (or cleared by
       * a send) since then retires the step instead of wiping that text.
       */
      const applyComposerStep = (entry, undo) => {
        if (entry.sessionId !== bindingRef.current?.id) return false;
        const actions = inputActionsRef.current;
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') return false;
        const current = readDraftText();
        const expected = undo ? entry.after : entry.before;
        if (current === null || current !== expected) return false;
        try {
          actions.setDraft(undo ? entry.before : entry.after);
          actions.persistDraft?.();
          setTextSelectionState(null);
          pendingSelectionRef.current = null;
          return true;
        } catch {
          return false;
        }
      };

      /**
       * Sends are irreversible: a card a send archived (`send` / `compose`
       * origin) is pinned to its current body, archived flag and origin in
       * every restored snapshot, and re-appended when the snapshot predates
       * it. Undo / redo therefore cannot unarchive, drop or rewrite it.
       */
      const keepSentCards = (target) => {
        const pinned = segmentsRef.current.filter((segment) => segment.archived === true
          && (segment.origin === ARCHIVE_ORIGIN.send || segment.origin === ARCHIVE_ORIGIN.compose));
        if (pinned.length === 0) return target;
        const pinnedById = new Map(pinned.map((segment) => [segment.id, segment]));
        const restored = target.map((segment) => pinnedById.get(segment.id) ?? segment);
        const present = new Set(restored.map((segment) => segment.id));
        for (const segment of pinned) if (!present.has(segment.id)) restored.push(segment);
        return restored;
      };

      // Sends are never recorded as steps: a send either reuses the current
      // archive state or only adds a sent card, so undo / redo have nothing of
      // their own to replay. `keepSentCards` keeps the cards themselves safe.

      /**
       * Finish a burst of text / title edits. Typing is recorded as one
       * coalesced step so plugin undo never jumps over (and loses) text that
       * was typed after the previous structural operation. Native undo inside
       * the field stays untouched.
       */
      const flushTextHistory = (record = true) => {
        const pending = textHistoryRef.current;
        if (pending === null) return;
        if (pending.timer) clearTimeout(pending.timer);
        textHistoryRef.current = null;
        if (record && !historyApplyingRef.current) {
          recordHistory(pending.before, segmentsRef.current);
        }
      };

      const noteTextEdit = (id) => {
        const pending = textHistoryRef.current;
        if (pending !== null && pending.id === id) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.timer = setTimeout(() => flushTextHistory(), 700);
          return;
        }
        flushTextHistory();
        const next = { id, before: segmentsRef.current, timer: 0 };
        next.timer = setTimeout(() => flushTextHistory(), 700);
        textHistoryRef.current = next;
      };

      /** A plain text edit is not a recorded step, but it invalidates redo. */
      const discardRedoHistory = () => {
        const state = historyRef.current;
        if (state.index >= state.entries.length) return;
        state.entries = state.entries.slice(0, state.index);
        setHistoryVer((version) => version + 1);
      };

      /**
       * Drop every snapshot that still contains an irreversibly deleted id,
       * so a later undo cannot resurrect it through an older state.
       */
      const discardHistoryFor = (ids) => {
        const state = historyRef.current;
        const kept = [];
        let removedBefore = 0;
        state.entries.forEach((entry, index) => {
          const drop = entry.kind !== 'composer'
            && (entry.before.some((segment) => ids.has(segment.id))
              || entry.after.some((segment) => ids.has(segment.id)));
          if (drop) {
            if (index < state.index) removedBefore += 1;
            return;
          }
          kept.push(entry);
        });
        state.entries = kept;
        state.index = Math.max(0, Math.min(state.index - removedBefore, state.entries.length));
        setHistoryVer((version) => version + 1);
      };

      const applyHistory = (direction) => {
        // Any still-pending typing burst is the newest change; commit it first
        // so undo / redo can never silently drop that text.
        flushTextHistory();
        const undo = direction !== 'redo';
        for (;;) {
          const state = historyRef.current;
          const entry = undo ? state.entries[state.index - 1] : state.entries[state.index];
          if (entry === undefined) return false;
          if (entry.kind === 'composer') {
            if (applyComposerStep(entry, undo)) {
              state.index += undo ? -1 : 1;
              setHistoryVer((version) => version + 1);
              showToast(t(undo ? 'undone' : 'redone'));
              return true;
            }
            // The composer moved on (typed text, another session, a send):
            // retire the stale step and keep undoing the neighbouring one.
            if (undo) {
              state.entries.splice(state.index - 1, 1);
              state.index -= 1;
            } else {
              state.entries.splice(state.index, 1);
            }
            setHistoryVer((version) => version + 1);
            continue;
          }
          historyApplyingRef.current = true;
          try {
            clearPendingImageDeletes();
            setSegmentUndo(new Map());
            setBatchUndoState(null);
            setTextSelectionState(null);
            const target = undo ? entry.before : entry.after;
            commitSegments(keepSentCards(target), { record: false });
            state.index += undo ? -1 : 1;
            setHistoryVer((version) => version + 1);
            showToast(t(undo ? 'undone' : 'redone'));
            return true;
          } finally {
            historyApplyingRef.current = false;
          }
        }
      };

      // Session + workspace -------------------------------------------------
      useEffect(() => {
        let disposed = false;
        const uiSession = ctx.get('uiSession');
        const sessions = ctx.get('sessions');
        const current = uiSession?.adapter?.current;
        if (current === undefined || sessions === undefined) {
          inputActionsRef.current = null;
          inputStateRef.current = null;
          setBinding(null);
          return undefined;
        }
        const sync = () => {
          if (disposed) return;
          const snapshot = current.getSnapshot();
          const id = typeof snapshot?.key === 'string' ? snapshot.key : undefined;
          const row = id !== undefined ? sessions.list.getSnapshot()?.byId?.[id] : undefined;
          const cwd = typeof row?.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined;
          inputActionsRef.current = snapshot?.props?.inputActions ?? null;
          inputStateRef.current = snapshot?.hooks?.input ?? null;
          const next = id !== undefined && cwd !== undefined ? { id, cwd } : null;
          bindingRef.current = next;
          setBinding((previous) =>
            previous !== null && next !== null && previous.id === next.id && previous.cwd === next.cwd
              ? previous
              : next);
        };
        const unsubscribeCurrent = current.subscribe(sync);
        const unsubscribeSessions = sessions.list.subscribe(sync);
        sync();
        return () => {
          disposed = true;
          unsubscribeCurrent?.();
          unsubscribeSessions?.();
        };
      }, []);

      // Only render over the conversation view, not over settings pages ----
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const check = () => {
          const visible = presentConversation();
          setPresent((previous) => (previous === visible ? previous : visible));
        };
        check();
        const timer = setInterval(check, 700);
        return () => clearInterval(timer);
      }, []);

      // Position + size ----------------------------------------------------
      useEffect(() => {
        setUi((previous) => clampUi(previous));
        const onResize = () => setUi((previous) => clampUi(previous));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      useEffect(() => {
        try {
          window.localStorage?.setItem(UI_KEY, JSON.stringify(ui));
        } catch {
          /* Storage may be unavailable; the widget still works per page. */
        }
      }, [ui]);

      // Live settings: the settings tab writes to the shared store --------
      useEffect(() => subscribeSettings((next) => {
        setSettings(next);
        if (next.saveMode === 'manual') clearTimer();
        else if (dirtyRef.current) scheduleSave();
      }), []);

      // Workspace dropdown closes on any outside pointer press -----------
      useEffect(() => {
        if (!wsOpen || typeof document === 'undefined') return undefined;
        const close = (event) => {
          const wrap = wsWrapRef.current;
          if (wrap !== null && wrap !== undefined && typeof wrap.contains === 'function'
            && event?.target !== undefined && event?.target !== null && wrap.contains(event.target)) return;
          setWsOpen(false);
        };
        document.addEventListener('pointerdown', close, true);
        return () => document.removeEventListener('pointerdown', close, true);
      }, [wsOpen]);

      // Never leave removal timers behind --------------------------------
      useEffect(() => () => {
        for (const timer of leaveTimersRef.current) clearTimeout(timer);
        leaveTimersRef.current.clear();
        leavingIdsRef.current.clear();
        if (textHistoryRef.current !== null && textHistoryRef.current.timer) {
          clearTimeout(textHistoryRef.current.timer);
        }
        textHistoryRef.current = null;
      }, []);

      // Re-grow cards when the height limit or typography changes --------
      useEffect(() => {
        for (const element of textareaRefs.current.values()) growTextarea(element);
      }, [settings.maxSegmentHeight, settings.fontSize, settings.font]);

      // Programmatic text changes (AI rewrite, undo/redo, split) bypass the
      // textarea onChange handler, so measure them again after the commit.
      useEffect(() => {
        if (!growAllRef.current) return;
        growAllRef.current = false;
        for (const element of textareaRefs.current.values()) growTextarea(element);
      }, [segments]);

      // Apply a pending text selection after an AI rewrite commits ------
      useEffect(() => {
        const pending = pendingSelectionRef.current;
        if (pending === null || pending === undefined) return;
        pendingSelectionRef.current = null;
        const element = textareaRefs.current.get(pending.id);
        if (element === null || element === undefined) return;
        try {
          element.focus?.({ preventScroll: true });
        } catch {
          try {
            element.focus?.();
          } catch {
            /* ignore */
          }
        }
        try {
          const value = typeof element.value === 'string' ? element.value : '';
          const start = Math.max(0, Math.min(Number(pending.start) || 0, value.length));
          const end = Math.max(start, Math.min(Number(pending.end) || start, value.length));
          if (typeof element.setSelectionRange === 'function') element.setSelectionRange(start, end);
        } catch {
          /* ignore */
        }
        try {
          element.scrollIntoView?.({ block: 'nearest' });
        } catch {
          /* ignore */
        }
        setTextSelectionState({
          id: pending.id,
          start: pending.start,
          end: pending.end,
        });
      }, [segments]);

      // Keep the archive list parked on its newest (top) card ------------
      useEffect(() => {
        if (!ui.showArchive) return undefined;
        const timer = setTimeout(() => {
          const list = archiveListRef.current;
          const first = list !== null && list !== undefined ? list.firstElementChild : null;
          if (first !== null && first !== undefined && typeof first.scrollIntoView === 'function') {
            try {
              first.scrollIntoView({ block: 'nearest' });
            } catch {
              /* A detached list cannot scroll. */
            }
          }
        }, 60);
        return () => clearTimeout(timer);
      }, [ui.showArchive, archivedSignature]);

      // Save plumbing -------------------------------------------------------
      const clearTimer = () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = 0;
        }
      };

      const showToast = (message, action) => {
        setToast({ id: Date.now(), message, action: action ?? null });
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), action === undefined || action === null ? 1800 : 5000);
      };

      /**
       * Grow a segment textarea without moving the surrounding list. Setting
       * `height:auto` collapses the card for one layout pass, which clamps the
       * list scrollTop and was the cause of auto-save jumping to the top.
       */
      const growTextarea = (element) => {
        if (element === null || element === undefined) return;
        const list = listRef.current;
        const top = list !== null && list !== undefined && Number.isFinite(list.scrollTop)
          ? list.scrollTop
          : null;
        autoGrow(element, settingsRef.current.maxSegmentHeight);
        if (list !== null && list !== undefined && top !== null && Number.isFinite(list.scrollTop)
          && list.scrollTop !== top) {
          try {
            list.scrollTop = top;
          } catch {
            /* A detached list cannot be scrolled. */
          }
        }
      };

      /** Boundary-preserving scroll snapshot for async saves and refreshes. */
      const captureListScroll = () => {
        const list = listRef.current;
        return list !== null && list !== undefined && Number.isFinite(list.scrollTop) ? list.scrollTop : null;
      };

      const restoreListScroll = (top) => {
        if (top === null || top === undefined) return;
        const list = listRef.current;
        if (list === null || list === undefined) return;
        try {
          if (list.scrollTop !== top) list.scrollTop = top;
        } catch {
          /* ignore */
        }
      };

      const resetGeometry = () => {
        const defaults = settingsRef.current;
        setUi((previous) => clampUi({
          ...previous,
          x: defaults.defaultX,
          y: defaults.defaultY,
          width: defaults.defaultWidth,
          height: defaults.defaultHeight,
        }));
        showToast(t('uiReset'));
      };

      useEffect(() => {
        resetHandlers.add(resetGeometry);
        return () => {
          resetHandlers.delete(resetGeometry);
        };
      }, []);

      const scheduleSave = () => {
        clearTimer();
        if (settingsRef.current.saveMode === 'manual') {
          setStatus('dirty');
          return;
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = 0;
          saveNowRef.current?.();
        }, SAVE_DELAY);
      };

      const saveNow = async (options = {}) => {
        clearTimer();
        const root = rootRef.current;
        const sessionId = rootSessionRef.current;
        if (root === '' || sessionId === '') return;
        if (!dirtyRef.current && options.force !== true) return;
        const body = serializeSegments(segmentsRef.current);
        const signature = JSON.stringify(body);
        const seq = ++seqRef.current;
        dirtyRef.current = false;
        setStatus('saving');
        setError('');
        try {
          const data = await saveNote(root, sessionId, body);
          if (seq !== seqRef.current || rootRef.current !== root) return;
          if (typeof data.mtimeMs === 'number') versionRef.current = data.mtimeMs;
          setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : Date.now());
          // Other Sessions' sidebar rows read the file, so let them re-read it
          // now instead of waiting for the next polling refresh.
          requestBadgeRefresh();
          if (JSON.stringify(serializeSegments(segmentsRef.current)) === signature) {
            dirtyRef.current = false;
            setStatus('saved');
          } else {
            dirtyRef.current = true;
            setStatus('dirty');
            scheduleSave();
          }
        } catch (reason) {
          if (seq !== seqRef.current || rootRef.current !== root) return;
          dirtyRef.current = true;
          setStatus('error');
          setError(String(reason?.message || reason));
        }
      };
      saveNowRef.current = saveNow;

      const commitSegments = (next, options = {}) => {
        flushTextHistory();
        const before = segmentsRef.current;
        invalidateBatchUndo();
        segmentsRef.current = next;
        growAllRef.current = true;
        setSegments(next);
        pruneSelectionFor(next);
        if (options.focus !== undefined) pendingFocusRef.current = options.focus;
        dirtyRef.current = true;
        setStatus('dirty');
        setError('');
        if (options.record !== false) recordHistory(before, next);
        scheduleSave();
      };

      // Load on workspace/session change ------------------------------------
      useEffect(() => {
        if (binding === null) {
          rootRef.current = '';
          rootSessionRef.current = '';
          loadedRef.current = false;
          collapseSeenRef.current = new Set();
          segmentsRef.current = [];
          setSegments([]);
          setSelection(new Set());
          setSegmentUndo(new Map());
          setBatchUndoState(null);
          setTitleEditing('');
          setPreviewImage(null);
          setDeleteConfirm('');
          pendingScrollRef.current = null;
          setTextSelectionState(null);
          setLeaving(new Map());
          resetHistory();
          historyRootRef.current = '';
          setStatus('idle');
          setError('');
          return undefined;
        }
        if (dirtyRef.current && rootRef.current !== '') {
          // Flush the old workspace/session note before this binding replaces
          // the in-memory segments; a same-workspace session switch must not
          // drop a still-debounced edit.
          saveNowRef.current?.({ force: true });
        }
        clearTimer();
        const root = binding.cwd;
        // Operation history belongs to one workspace note; switching away
        // (or loading a new note) discards it rather than replaying snapshots
        // from another document.
        if (historyRootRef.current !== root) {
          resetHistory();
          historyRootRef.current = root;
          collapseSeenRef.current = new Set();
          syncCollapsed(new Set());
        }
        for (const timer of leaveTimersRef.current) clearTimeout(timer);
        leaveTimersRef.current.clear();
        leavingIdsRef.current.clear();
        setLeaving(new Map());
        rootRef.current = root;
        rootSessionRef.current = binding.id;
        let cancelled = false;
        loadedRef.current = false;
        loadFailedRef.current = false;
        segmentsRef.current = [];
        setSegments([]);
        setSelection(new Set());
        setSegmentUndo(new Map());
        setBatchUndoState(null);
        setTitleEditing('');
        setPreviewImage(null);
        setDeleteConfirm('');
        pendingScrollRef.current = null;
        setTextSelectionState(null);
        setStatus('loading');
        setError('');
        const load = () => {
          const mySeq = ++loadSeqRef.current;
          loadedRef.current = false;
          loadFailedRef.current = false;
          setStatus('loading');
          setError('');
          fetchNote(root, binding.id)
            .then((data) => {
              if (cancelled || rootRef.current !== root || mySeq !== loadSeqRef.current) return;
              let value = readServerSegments(data);
              if (value.length === 0) value = [newSegment('')];
              segmentsRef.current = value;
              growAllRef.current = true;
              setSegments(value);
              setSelection(new Set());
              setSegmentUndo(new Map());
              setBatchUndoState(null);
              resetHistory();
              applyArchiveCollapseDefaults(value);
              versionRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
              setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : null);
              dirtyRef.current = false;
              loadedRef.current = true;
              setStatus('saved');
            })
            .catch((reason) => {
              if (cancelled || rootRef.current !== root || mySeq !== loadSeqRef.current) return;
              loadFailedRef.current = true;
              loadedRef.current = false;
              setStatus('error');
              setError(String(reason?.message || reason));
            });
        };
        reloadRef.current = load;
        load();
        return () => {
          cancelled = true;
          if (reloadRef.current === load) reloadRef.current = null;
        };
      }, [binding === null ? '' : binding.id, binding === null ? '' : binding.cwd]);

      // Sidebar workspace badges --------------------------------------------
      useEffect(() => {
        if (binding === null) {
          setCurrentWsId('');
          setWsCounts({});
          setWsList([]);
          setWsOpen(false);
          return undefined;
        }
        setCurrentWsId('');
        setWsOpen(false);
        let disposed = false;
        const refresh = () => {
          const sessionId = binding.id;
          if (typeof sessionId !== 'string' || sessionId === '') return;
          fetchUnsentCounts(sessionId)
            .then((data) => {
              if (disposed || bindingRef.current?.id !== sessionId) return;
              const next = {};
              const list = [];
              for (const workspace of Array.isArray(data?.workspaces) ? data.workspaces : []) {
                const id = typeof workspace?.id === 'string' ? workspace.id : '';
                if (id === '') continue;
                const count = Number.isFinite(workspace.count) ? Math.max(0, Math.floor(workspace.count)) : 0;
                next[id] = count;
                list.push({
                  id,
                  path: typeof workspace.path === 'string' ? workspace.path : '',
                  title: typeof workspace.title === 'string' ? workspace.title : '',
                  count,
                  hasContent: workspace.hasContent === true,
                });
              }
              setWsCounts(next);
              setWsList(list);
              const matched = resolveWorkspaceId(ctx, binding.cwd, sessionId, list);
              if (matched !== '') setCurrentWsId(matched);
            })
            .catch(() => {});
        };
        // A save in another Session of this client wakes the badges up right
        // away; the interval only covers changes made outside the app.
        badgeRefreshers.add(refresh);
        refresh();
        const timer = setInterval(refresh, SIDEBAR_REFRESH_MS);
        const onFocus = () => refresh();
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh();
        };
        window.addEventListener('focus', onFocus);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        return () => {
          disposed = true;
          badgeRefreshers.delete(refresh);
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [binding === null ? '' : binding.id, binding === null ? '' : binding.cwd]);

      const localUnsentCount = countUnsent(segments);
      // While the current note is loaded, its live count is the truth for this
      // Workspace: a counts response that raced the save must not roll the
      // badge back to a stale value.
      const liveCountReady = currentWsId !== ''
        && (status === 'saved' || status === 'saving' || status === 'dirty');

      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined;
        const apply = () => {
          let rows;
          try {
            rows = document.querySelectorAll('[data-row-key^="workspace:"]');
          } catch {
            return;
          }
          for (const row of rows) {
            const key = typeof row.getAttribute === 'function' ? String(row.getAttribute('data-row-key') ?? '') : '';
            const id = key.startsWith('workspace:') ? key.slice('workspace:'.length) : '';
            const count = id === ''
              ? 0
              : (id === currentWsId && liveCountReady ? localUnsentCount : (wsCounts[id] ?? 0));
            const value = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
            const previous = typeof row.getAttribute === 'function' ? row.getAttribute('data-np-unsent') : null;
            if (value === '') {
              if (previous !== null) row.removeAttribute('data-np-unsent');
            } else if (previous !== value) {
              row.setAttribute('data-np-unsent', value);
            }
          }
        };
        apply();
        const Observer = typeof globalThis !== 'undefined' ? globalThis.MutationObserver : undefined;
        if (typeof Observer !== 'function' || typeof document.body === 'undefined' || document.body === null) {
          return () => apply();
        }
        const observer = new Observer(apply);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
          observer.disconnect();
          apply();
        };
      }, [wsCounts, currentWsId, liveCountReady, localUnsentCount]);

      // Focus a just-created or restored card ------------------------------
      useEffect(() => {
        const pending = pendingFocusRef.current;
        if (pending === null || pending === undefined) return;
        pendingFocusRef.current = null;
        const element = textareaRefs.current.get(pending.id);
        if (element === undefined || element === null) return;
        try {
          element.focus?.({ preventScroll: true });
        } catch {
          try {
            element.focus?.();
          } catch {
            /* ignore */
          }
        }
        try {
          const value = typeof element.value === 'string' ? element.value : '';
          const caret = Math.max(0, Math.min(Number(pending.caret) || 0, value.length));
          if (typeof element.setSelectionRange === 'function') element.setSelectionRange(caret, caret);
        } catch {
          /* ignore */
        }
        try {
          element.scrollIntoView?.({ block: 'nearest' });
        } catch {
          /* ignore */
        }
        growTextarea(element);
      }, [segments]);

      // Restore a captured scroll offset right after a refresh commits ------
      useLayoutEffect(() => {
        const pending = pendingScrollRef.current;
        if (pending === null || pending === undefined) return;
        pendingScrollRef.current = null;
        const list = listRef.current;
        if (list === null || list === undefined) return;
        try {
          list.scrollTop = pending;
        } catch {
          /* A detached list cannot be scrolled. */
        }
      }, [segments]);

      // Keyboard ------------------------------------------------------------
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event?.isComposing === true) return;
          if (shortcutRecording) return;
          const shortcuts = settingsRef.current.shortcuts;
          const chordFor = (action) => parseShortcut(shortcuts[action]);
          const hostOwns = (action) => hostHandledShortcuts.has(action);
          if (!hostOwns('undo') && shortcutMatches(event, chordFor('undo'))) {
            // Textareas and inputs keep their native undo/redo history.
            if (isEditableTarget(event.target)) return;
            event.preventDefault();
            applyHistory('undo');
            return;
          }
          if (!hostOwns('redo') && shortcutMatches(event, chordFor('redo'))) {
            if (isEditableTarget(event.target)) return;
            event.preventDefault();
            applyHistory('redo');
            return;
          }
          if (!hostOwns('toggle') && shortcutMatches(event, chordFor('toggle'))) {
            event.preventDefault();
            requestToggleVisibility();
            return;
          }
          if (!hostOwns('save') && shortcutMatches(event, chordFor('save'))) {
            event.preventDefault();
            saveNowRef.current?.({ force: true });
            return;
          }
          if (!hostOwns('reset') && shortcutMatches(event, chordFor('reset'))) {
            event.preventDefault();
            resetGeometry();
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          clearTimer();
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          for (const timer of imageDeleteTimersRef.current.values()) clearTimeout(timer);
          imageDeleteTimersRef.current.clear();
        };
      }, []);

      // Host shortcut / settings-tab entry points ---------------------------
      useEffect(() => {
        const visibility = () => setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
        const history = (direction) => applyHistory(direction);
        const save = () => saveNowRef.current?.({ force: true });
        const geometry = () => {
          const current = uiRef.current;
          return {
            x: current.x,
            y: current.y,
            width: current.width,
            height: current.height,
          };
        };
        visibilityHandlers.add(visibility);
        historyHandlers.add(history);
        saveHandlers.add(save);
        geometryHandlers.add(geometry);
        return () => {
          visibilityHandlers.delete(visibility);
          historyHandlers.delete(history);
          saveHandlers.delete(save);
          geometryHandlers.delete(geometry);
        };
      }, []);

      // Close the preview / delete confirmation with Escape ----------------
      useEffect(() => {
        if (previewImage === null && deleteConfirm === '' && wsOpen !== true) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setPreviewImage(null);
          setDeleteConfirm('');
          setWsOpen(false);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [previewImage, deleteConfirm, wsOpen]);

      // Flush on page hide / reload -----------------------------------------
      useEffect(() => {
        const flush = () => {
          if (dirtyRef.current) saveNowRef.current?.({ force: true });
        };
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('pagehide', flush);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          flush();
          window.removeEventListener('pagehide', flush);
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, []);

      // Adopt external edits when the window regains focus ------------------
      useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const refresh = () => {
          const root = rootRef.current;
          const sessionId = rootSessionRef.current;
          if (root === '' || sessionId === '' || dirtyRef.current || timerRef.current) return;
          const active = typeof document !== 'undefined' ? document.activeElement : null;
          if (active !== null && active !== undefined && typeof active.closest === 'function'
            && active.closest('[data-dsh-notepad="true"]') !== null) return;
          // Snapshot the scroll offset right before the refresh; the list may
          // re-render (and jump) while the updated note is applied.
          const list = listRef.current;
          const scrollTop = list !== null && list !== undefined && Number.isFinite(list.scrollTop)
            ? list.scrollTop
            : null;
          const mySeq = ++refreshSeqRef.current;
          pendingScrollRef.current = scrollTop;
          fetchNote(root, sessionId)
            .then((data) => {
              if (mySeq !== refreshSeqRef.current) return;
              if (rootRef.current !== root || dirtyRef.current) {
                pendingScrollRef.current = null;
                return;
              }
              if (typeof data.mtimeMs === 'number' && data.mtimeMs === versionRef.current) {
                pendingScrollRef.current = null;
                return;
              }
              let incoming = readServerSegments(data);
              if (incoming.length === 0) incoming = [newSegment('')];
              const value = mergeServerOrder(segmentsRef.current, incoming);
              segmentsRef.current = value;
              growAllRef.current = true;
              setSegments(value);
              pruneSelectionFor(value);
              applyArchiveCollapseDefaults(value);
              setSegmentUndo(new Map());
              setBatchUndoState(null);
              resetHistory();
              versionRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
              setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : null);
              setStatus('saved');
            })
            .catch(() => {
              if (mySeq === refreshSeqRef.current) pendingScrollRef.current = null;
            });
        };
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh();
        };
        window.addEventListener('focus', refresh);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          window.removeEventListener('focus', refresh);
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, []);

      // Segment mutations ---------------------------------------------------
      const updateSegmentText = (id, value) => {
        invalidateBatchUndo();
        discardRedoHistory();
        noteTextEdit(id);
        const next = segmentsRef.current.map((segment) => (segment.id === id ? { ...segment, text: value } : segment));
        segmentsRef.current = next;
        setSegments(next);
        setSegmentUndo((previous) => {
          const record = previous.get(id);
          if (record === undefined || record.after === value) return previous;
          const pruned = new Map(previous);
          pruned.delete(id);
          return pruned;
        });
        dirtyRef.current = true;
        setStatus('dirty');
        setError('');
        scheduleSave();
      };

      const updateSegmentTitle = (id, value) => {
        const title = String(value ?? '').slice(0, MAX_TITLE_CHARS);
        const target = segmentsRef.current.find((segment) => segment.id === id);
        if (target === undefined || target.title === title) return;
        invalidateBatchUndo();
        discardRedoHistory();
        noteTextEdit(id);
        const next = segmentsRef.current.map((segment) => (segment.id === id ? { ...segment, title } : segment));
        segmentsRef.current = next;
        setSegments(next);
        dirtyRef.current = true;
        setStatus('dirty');
        setError('');
        scheduleSave();
      };

      // Image attachments ---------------------------------------------------
      const imageErrorText = (reason) => {
        const code = reason?.code;
        if (code === 'too-large') return t('imageTooLarge');
        if (code === 'unsupported') return t('imageUnsupported');
        if (code === 'too-many') return t('imageTooMany', { n: MAX_IMAGES });
        return `${t('imageFailed')}: ${String(reason?.message ?? reason)}`;
      };

      const appendImages = (id, images) => {
        if (!Array.isArray(images) || images.length === 0) return 0;
        const target = segmentsRef.current.find((segment) => segment.id === id);
        if (target === undefined || target.archived === true) return 0;
        const existing = Array.isArray(target.images) ? target.images : [];
        const room = Math.max(0, MAX_IMAGES - existing.length);
        if (room === 0) {
          showToast(t('imageTooMany', { n: MAX_IMAGES }));
          return 0;
        }
        const accepted = images.slice(0, room);
        const next = segmentsRef.current.map((segment) =>
          (segment.id === id ? { ...segment, images: [...existing, ...accepted] } : segment));
        commitSegments(next);
        if (accepted.length < images.length) showToast(t('imageTooMany', { n: MAX_IMAGES }));
        else showToast(t('imageAdded', { n: accepted.length }));
        return accepted.length;
      };

      /**
       * Add browser files to one segment. Pasted images are always written into
       * the plugin directory; selected images use their host path when the
       * desktop bridge exposes it and fall back to the same upload otherwise.
       * @param {string} id segment id
       * @param {ArrayLike<File>} files
       * @param {'paste'|'pick'} origin
       */
      const attachImages = async (id, files, origin) => {
        const list = Array.from(files ?? []).filter(isSupportedImage);
        if (list.length === 0) {
          showToast(t('imageUnsupported'));
          return;
        }
        const root = rootRef.current;
        const sessionId = rootSessionRef.current;
        if (root === '' || sessionId === '') return;
        setUploading((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + list.length }));
        const collected = [];
        try {
          for (const file of list) {
            const directPath = origin === 'pick' ? hostPathOf(file) : '';
            if (directPath !== '') {
              collected.push({
                path: imagePathForNote(directPath, bindingRef.current?.cwd ?? root),
                name: baseNameOf(directPath) || file?.name || 'image',
              });
              continue;
            }
            collected.push(await uploadImage(root, sessionId, file));
          }
          if (collected.length > 0) appendImages(id, collected);
        } catch (reason) {
          if (collected.length > 0) appendImages(id, collected);
          showToast(imageErrorText(reason));
        } finally {
          setUploading((previous) => {
            const next = { ...previous };
            const remaining = (next[id] ?? 0) - list.length;
            if (remaining > 0) next[id] = remaining;
            else delete next[id];
            return next;
          });
        }
      };

      const clearPendingImageDeletes = () => {
        for (const timer of imageDeleteTimersRef.current.values()) {
          clearTimeout(timer);
        }
        imageDeleteTimersRef.current.clear();
      };

      const deleteImageFile = (pathValue) => {
        const root = rootRef.current;
        const sessionId = rootSessionRef.current;
        if (root === '' || sessionId === '' || typeof pathValue !== 'string' || pathValue === '') return;
        removeStoredImage(root, sessionId, pathValue).catch(() => {});
      };

      const scheduleImageCleanup = (images) => {
        const list = Array.isArray(images) ? images : [];
        for (const image of list) {
          const pathValue = typeof image?.path === 'string' ? image.path : '';
          if (pathValue === '' || imageDeleteTimersRef.current.has(pathValue)) continue;
          const timer = setTimeout(() => {
            imageDeleteTimersRef.current.delete(pathValue);
            if (!segmentsRef.current.some((segment) =>
              (Array.isArray(segment.images) ? segment.images : []).some((item) => item.path === pathValue))) {
              deleteImageFile(pathValue);
            }
          }, IMAGE_DELETE_DELAY);
          imageDeleteTimersRef.current.set(pathValue, timer);
        }
      };

      const removeImage = (id, pathValue) => {
        const next = segmentsRef.current.map((segment) => {
          if (segment.id !== id) return segment;
          const images = Array.isArray(segment.images) ? segment.images.filter((image) => image.path !== pathValue) : [];
          return { ...segment, images };
        });
        const stillReferenced = next.some((segment) =>
          (Array.isArray(segment.images) ? segment.images : []).some((image) => image.path === pathValue));
        commitSegments(next);
        if (previewImage !== null && previewImage.path === pathValue) setPreviewImage(null);
        if (!stillReferenced) deleteImageFile(pathValue);
      };

      const triggerFilePicker = (id) => {
        const input = fileInputRefs.current.get(id);
        if (input !== undefined && input !== null && typeof input.click === 'function') input.click();
      };

      const onFileInputChange = (event, id) => {
        const input = event?.currentTarget ?? event?.target;
        const files = input?.files;
        if (files !== undefined && files !== null && files.length > 0) attachImages(id, files, 'pick');
        try {
          if (input !== null && input !== undefined) input.value = '';
        } catch {
          /* A read-only file input value must not break the flow. */
        }
      };

      const clipboardImageFiles = (data) => {
        const files = data?.files;
        if (files === undefined || files === null) return [];
        return Array.from(files).filter(isSupportedImage);
      };

      const onSegmentPaste = (event, id) => {
        const data = event?.clipboardData ?? event?.nativeEvent?.clipboardData;
        const files = clipboardImageFiles(data);
        if (files.length === 0) return;
        event.preventDefault?.();
        event?.stopPropagation?.();
        attachImages(id, files, 'paste');
      };

      const onSegmentDrop = (event, id) => {
        const files = clipboardImageFiles(event?.dataTransfer);
        setDragSegment('');
        if (files.length === 0) return;
        event.preventDefault?.();
        event?.stopPropagation?.();
        attachImages(id, files, 'pick');
      };

      const onSegmentDragOver = (event, id) => {
        const types = event?.dataTransfer?.types;
        if (types !== undefined && types !== null && !Array.from(types).includes('Files')) return;
        event.preventDefault?.();
        if (dragSegment !== id) setDragSegment(id);
      };

      const onSegmentDragLeave = (event, id) => {
        const related = event?.relatedTarget;
        const current = event?.currentTarget;
        if (related !== null && related !== undefined && current !== null && current !== undefined
          && typeof current.contains === 'function' && current.contains(related)) return;
        if (dragSegment === id) setDragSegment('');
      };

      const openImage = (image) => {
        setPreviewImage({ path: image.path, name: image.name });
      };

      const openOriginalImage = (image) => {
        const url = imageUrl(image.path, rootRef.current);
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          /* Popups may be blocked; the in-panel preview still works. */
        }
      };

      const addSegment = () => {
        if (segmentsRef.current.length >= MAX_SEGMENTS) {
          showToast(t('tooManySegments', { n: MAX_SEGMENTS }));
          return;
        }
        const segment = newSegment('');
        commitSegments([...segmentsRef.current, segment], { focus: { id: segment.id, caret: 0 } });
      };

      const splitSegment = (id, element) => {
        const current = segmentsRef.current.find((segment) => segment.id === id);
        if (current === undefined) return;
        const start = typeof element?.selectionStart === 'number' ? element.selectionStart : current.text.length;
        const head = current.text.slice(0, start);
        const tail = current.text.slice(start);
        const nextSegment = newSegment(tail);
        const updated = segmentsRef.current.map((segment) =>
          (segment.id === id ? { ...segment, text: head } : segment));
        // Cards are displayed oldest-first, so the split tail always follows
        // its source card (also for an empty tail at the end of the note).
        const next = [];
        for (const segment of updated) {
          next.push(segment);
          if (segment.id === id) next.push(nextSegment);
        }
        commitSegments(next, { focus: { id: nextSegment.id, caret: 0 } });
      };

      /**
       * Mark cards as leaving, then commit the structural change after the
       * short exit animation. Removal used to be instant, which made archive
       * and delete feel like the cards vanished while new cards animated in.
       */
      const scheduleLeave = (ids, kind, run) => {
        const list = [...new Set(Array.isArray(ids) ? ids : [ids])]
          .filter((id) => typeof id === 'string' && id !== '' && !leavingIdsRef.current.has(id));
        if (list.length === 0) return;
        for (const id of list) leavingIdsRef.current.add(id);
        setLeaving((previous) => {
          const next = new Map(previous);
          for (const id of list) next.set(id, kind);
          return next;
        });
        const timer = setTimeout(() => {
          leaveTimersRef.current.delete(timer);
          for (const id of list) leavingIdsRef.current.delete(id);
          setLeaving((previous) => {
            const next = new Map(previous);
            for (const id of list) next.delete(id);
            return next;
          });
          run();
        }, 160);
        leaveTimersRef.current.add(timer);
      };

      const archiveSegment = (id) => {
        const current = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
        if (current === undefined) return;
        scheduleLeave([id], 'archive', () => {
          const latest = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
          if (latest === undefined) return;
          const archivedAt = new Date().toISOString();
          const next = segmentsRef.current.map((segment) =>
            (segment.id === id
              ? { ...segment, archived: true, archivedAt, origin: ARCHIVE_ORIGIN.manual }
              : segment));
          setSelection(new Set([...selectedRef.current].filter((value) => value !== id)));
          setArchiveCollapse([id], ARCHIVE_ORIGIN.manual);
          commitSegments(next);
          showToast(t('archivedToast'));
        });
      };

      const archiveSelected = () => {
        const ids = new Set(
          segmentsRef.current
            .filter((segment) => segment.archived !== true && selectedRef.current.has(segment.id))
            .map((segment) => segment.id),
        );
        if (ids.size === 0) return;
        scheduleLeave([...ids], 'archive', () => {
          const live = new Set(
            segmentsRef.current
              .filter((segment) => segment.archived !== true && ids.has(segment.id))
              .map((segment) => segment.id),
          );
          if (live.size === 0) return;
          const archivedAt = new Date().toISOString();
          const next = segmentsRef.current.map((segment) =>
            (live.has(segment.id)
              ? { ...segment, archived: true, archivedAt, origin: ARCHIVE_ORIGIN.manual }
              : segment));
          setSelection(new Set());
          setArchiveCollapse(live, ARCHIVE_ORIGIN.manual);
          commitSegments(next);
          showToast(t('archivedCount', { n: live.size }));
        });
      };

      const restoreSegment = (id) => {
        const current = segmentsRef.current.find((segment) => segment.id === id && segment.archived === true);
        if (current === undefined) return;
        const next = segmentsRef.current.map((segment) =>
          (segment.id === id
            ? { ...segment, archived: false, archivedAt: null, origin: null }
            : segment));
        forgetArchiveCollapse([id]);
        commitSegments(next, { focus: { id, caret: current.text.length } });
        showToast(t('restoredToast'));
      };

      const restoreAll = () => {
        const restored = segmentsRef.current.filter((segment) => segment.archived === true);
        if (restored.length === 0) return;
        const next = segmentsRef.current.map((segment) =>
          (segment.archived === true
            ? { ...segment, archived: false, archivedAt: null, origin: null }
            : segment));
        forgetArchiveCollapse(restored.map((segment) => segment.id));
        commitSegments(next);
        showToast(t('restoredCount', { n: restored.length }));
      };

      const undoLast = () => {
        const record = undoRef.current;
        if (record === null || record === undefined) return;
        undoRef.current = null;
        clearPendingImageDeletes();
        setSegmentUndo(new Map());
        setBatchUndoState(null);
        commitSegments(record.snapshot);
        setToast(null);
      };

      const deleteArchived = (id) => {
        const target = segmentsRef.current.find((segment) => segment.id === id && segment.archived === true);
        if (target === undefined) return;
        scheduleLeave([id], 'delete', () => {
          const latest = segmentsRef.current.find((segment) => segment.id === id && segment.archived === true);
          if (latest === undefined) return;
          undoRef.current = { snapshot: segmentsRef.current };
          const next = segmentsRef.current.filter((segment) => segment.id !== id);
          forgetArchiveCollapse([id]);
          commitSegments(next);
          scheduleImageCleanup(latest.images);
          showToast(t('deletedToast'), { label: t('undo'), onClick: undoLast });
        });
      };

      /** Irreversible delete for an active segment, gated by a confirmation. */
      const deleteActiveSegment = (id) => {
        setDeleteConfirm('');
        setPreviewImage(null);
        const target = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
        if (target === undefined) return;
        // This delete cannot be undone: retire any older snackbar undo so it
        // cannot resurrect the segment through a stale snapshot.
        undoRef.current = null;
        setToast(null);
        setSegmentUndo((previous) => {
          if (!previous.has(id)) return previous;
          const updated = new Map(previous);
          updated.delete(id);
          return updated;
        });
        scheduleLeave([id], 'delete', () => {
          const latest = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
          if (latest === undefined) return;
          const next = segmentsRef.current.filter((segment) => segment.id !== id);
          // Irreversible delete: deliberately not part of plugin history.
          forgetArchiveCollapse([id]);
          commitSegments(next, { record: false });
          discardHistoryFor(new Set([id]));
          scheduleImageCleanup(latest.images);
          showToast(t('deletedToast'));
        });
      };

      /** Batch delete for the selected active segments. */
      const deleteSelectedSegments = () => {
        setDeleteConfirm('');
        setPreviewImage(null);
        const ids = new Set(
          segmentsRef.current
            .filter((segment) => segment.archived !== true && selectedRef.current.has(segment.id))
            .map((segment) => segment.id),
        );
        if (ids.size === 0) return;
        undoRef.current = null;
        setToast(null);
        scheduleLeave([...ids], 'delete', () => {
          const removed = segmentsRef.current.filter((segment) => ids.has(segment.id));
          if (removed.length === 0) return;
          setSelection(new Set());
          const next = segmentsRef.current.filter((segment) => !ids.has(segment.id));
          // Irreversible batch delete: deliberately not part of plugin history.
          forgetArchiveCollapse(ids);
          commitSegments(next, { record: false });
          discardHistoryFor(ids);
          scheduleImageCleanup(removed.flatMap((segment) => (Array.isArray(segment.images) ? segment.images : [])));
          showToast(t('deletedToast'));
        });
      };

      const clearArchive = () => {
        const archived = segmentsRef.current.filter((segment) => segment.archived === true);
        if (archived.length === 0) return;
        scheduleLeave(archived.map((segment) => segment.id), 'delete', () => {
          const current = segmentsRef.current.filter((segment) => segment.archived === true);
          if (current.length === 0) return;
          undoRef.current = { snapshot: segmentsRef.current };
          const next = segmentsRef.current.filter((segment) => segment.archived !== true);
          forgetArchiveCollapse(current.map((segment) => segment.id));
          commitSegments(next);
          scheduleImageCleanup(current.flatMap((segment) => (Array.isArray(segment.images) ? segment.images : [])));
          showToast(t('clearedArchive', { n: current.length }), { label: t('undo'), onClick: undoLast });
        });
      };

      // Merge / reorder -----------------------------------------------------
      const mergeSelected = () => {
        const ids = new Set(
          segmentsRef.current
            .filter((segment) => segment.archived !== true && selectedRef.current.has(segment.id))
            .map((segment) => segment.id),
        );
        if (ids.size < 2) {
          showToast(t('mergeHint'));
          return;
        }
        const chosen = segmentsRef.current.filter((segment) => ids.has(segment.id));
        const firstIndex = segmentsRef.current.findIndex((segment) => ids.has(segment.id));
        let insertAt = 0;
        for (let index = 0; index < firstIndex; index += 1) {
          if (!ids.has(segmentsRef.current[index].id)) insertAt += 1;
        }
        const images = collectImages(chosen);
        const merged = {
          id: newSegmentId(),
          text: chosen.map((segment) => segment.text).filter((text) => text.trim() !== '').join('\n\n'),
          title: chosen
            .map((segment) => (typeof segment.title === 'string' ? segment.title.trim() : ''))
            .filter((title) => title !== '')
            .join(' · ')
            .slice(0, MAX_TITLE_CHARS),
          createdAt: nowIso(),
          images,
          archived: false,
          archivedAt: null,
          origin: null,
        };
        undoRef.current = { snapshot: segmentsRef.current };
        const next = segmentsRef.current.filter((segment) => !ids.has(segment.id));
        next.splice(Math.min(insertAt, next.length), 0, merged);
        setSelection(new Set());
        commitSegments(next, { focus: { id: merged.id, caret: merged.text.length } });
        showToast(t('mergedToast', { n: chosen.length }), { label: t('undo'), onClick: undoLast });
      };

      const reorderSegments = (sourceId, targetId, after) => {
        if (sourceId === '' || sourceId === targetId) return;
        const active = segmentsRef.current.filter((segment) => segment.archived !== true);
        const from = active.findIndex((segment) => segment.id === sourceId);
        const to = active.findIndex((segment) => segment.id === targetId);
        if (from < 0 || to < 0) return;
        const moved = active.splice(from, 1)[0];
        let insertAt = to + (after ? 1 : 0);
        if (from < insertAt) insertAt -= 1;
        insertAt = Math.max(0, Math.min(insertAt, active.length));
        active.splice(insertAt, 0, moved);
        let cursor = 0;
        const next = segmentsRef.current.map((segment) =>
          (segment.archived === true ? segment : active[cursor++]));
        if (next.every((segment, index) => segment.id === segmentsRef.current[index].id)) return;
        commitSegments(next);
      };

      const setReorderTarget = (target) => {
        reorderOverRef.current = target;
        setReorderOver(target);
      };

      const onSegmentReorderStart = (event, id) => {
        reorderDragRef.current = id;
        setReorderDrag(id);
        try {
          event.dataTransfer?.setData('application/x-dsh-notepad-segment', id);
          if (event.dataTransfer !== undefined && event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
        } catch {
          /* Some browsers expose a read-only transfer. */
        }
      };

      const onSegmentReorderOver = (event, id) => {
        const source = reorderDragRef.current;
        if (source === '' || source === id) return;
        const types = event?.dataTransfer?.types;
        if (types !== undefined && types !== null && !Array.from(types).includes('application/x-dsh-notepad-segment')) return;
        event.preventDefault?.();
        event?.stopPropagation?.();
        const rect = typeof event.currentTarget?.getBoundingClientRect === 'function'
          ? event.currentTarget.getBoundingClientRect()
          : null;
        const after = rect !== null && Number(event.clientY) > rect.top + rect.height / 2;
        if (reorderOverRef.current?.id !== id || reorderOverRef.current?.after !== after) {
          setReorderTarget({ id, after });
        }
      };

      const onSegmentReorderDrop = (event, id) => {
        const source = reorderDragRef.current
          || (() => {
            try {
              return event?.dataTransfer?.getData('application/x-dsh-notepad-segment') ?? '';
            } catch {
              return '';
            }
          })();
        const target = reorderOverRef.current?.id === id ? reorderOverRef.current : null;
        reorderDragRef.current = '';
        setReorderDrag('');
        setReorderTarget(null);
        if (source === '') return;
        event.preventDefault?.();
        event?.stopPropagation?.();
        reorderSegments(source, id, target?.after === true);
      };

      // AI optimization -----------------------------------------------------
      const markOptimizing = (id, active) => {
        const next = new Set(optimizingRef.current);
        if (active) next.add(id);
        else next.delete(id);
        optimizingRef.current = next;
        setOptimizing(next);
      };

      /** Cache key: the prompt depends on the workspace, title, preset and text. */
      const optimizationCacheKey = (root, title, text, instruction) =>
        `${root}\u0000${title ?? ''}\u0000${instruction ?? ''}\u0000${text}`;

      const rememberOptimization = (key, value) => {
        const cache = optimizeCacheRef.current;
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > OPTIMIZE_CACHE_LIMIT) {
          const oldest = cache.keys().next();
          if (oldest.done === true) break;
          cache.delete(oldest.value);
        }
      };

      /** Selection range inside a card, when it is still valid for that card. */
      const selectionRangeFor = (segment) => {
        const selection = textSelectionRef.current;
        if (selection === null || selection === undefined || selection.id !== segment.id) return null;
        const length = typeof segment.text === 'string' ? segment.text.length : 0;
        const start = Math.max(0, Math.min(Number(selection.start) || 0, length));
        const end = Math.max(start, Math.min(Number(selection.end) || start, length));
        return end > start ? { start, end } : null;
      };

      const requestOptimization = async (text, title) => {
        const root = rootRef.current;
        const sessionId = rootSessionRef.current;
        if (root === '' || sessionId === '') throw new Error(t('optimizeUnavailable'));
        if (text.length > MAX_OPTIMIZE_CHARS) throw new Error(t('optimizeTooLong'));
        const instruction = aiInstruction(settingsRef.current);
        const cacheKey = optimizationCacheKey(root, title, text, instruction);
        const cached = optimizeCacheRef.current.get(cacheKey);
        if (typeof cached === 'string' && cached !== '') return cached;
        const data = await optimizeNoteText(root, sessionId, text, title, instruction);
        const value = typeof data.text === 'string' ? data.text.trim() : '';
        if (value === '') throw new Error(t('optimizeFailed'));
        rememberOptimization(cacheKey, value);
        return value;
      };

      const optimizeSegment = async (id) => {
        if (optimizingRef.current.has(id)) return;
        const target = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
        if (target === undefined) return;
        const selection = selectionRangeFor(target);
        const source = selection === null
          ? target.text
          : target.text.slice(selection.start, selection.end);
        if (source.trim() === '') {
          showToast(selection === null ? t('optimizeEmpty') : t('optimizeSelectionEmpty'));
          return;
        }
        const original = target.text;
        const title = selection === null ? (target.title ?? '') : '';
        markOptimizing(id, true);
        try {
          const value = await requestOptimization(source, title);
          const current = segmentsRef.current.find((segment) => segment.id === id);
          if (current === undefined || current.text !== original) return;
          const nextText = selection === null
            ? value
            : `${original.slice(0, selection.start)}${value}${original.slice(selection.end)}`;
          if (nextText === original) return;
          commitSegments(segmentsRef.current.map((segment) =>
            (segment.id === id ? { ...segment, text: nextText } : segment)));
          if (selection !== null) {
            pendingSelectionRef.current = {
              id,
              start: selection.start,
              end: selection.start + value.length,
            };
          } else if (textSelectionRef.current?.id === id) {
            setTextSelectionState(null);
          }
          setSegmentUndo((previous) => {
            const updated = new Map(previous);
            updated.set(id, {
              before: original,
              after: nextText,
              selection: selection === null ? null : { ...selection },
              afterSelection: selection === null
                ? null
                : { start: selection.start, end: selection.start + value.length },
            });
            return updated;
          });
          showToast(selection === null ? t('optimizedToast') : t('selectionOptimized'));
        } catch (reason) {
          const message = String(reason?.message ?? reason);
          showToast(message === t('optimizeTooLong') || message === t('optimizeUnavailable')
            ? message
            : `${t('optimizeFailed')}: ${message}`);
        } finally {
          markOptimizing(id, false);
        }
      };

      const undoOptimizeSegment = (id) => {
        const record = segmentUndo.get(id);
        const current = segmentsRef.current.find((segment) => segment.id === id);
        if (record !== undefined && current !== undefined && current.text === record.after) {
          commitSegments(segmentsRef.current.map((segment) =>
            (segment.id === id ? { ...segment, text: record.before } : segment)));
          if (record.selection !== null && record.selection !== undefined) {
            pendingSelectionRef.current = { id, ...record.selection };
          }
          setSegmentUndo((previous) => {
            if (!previous.has(id)) return previous;
            const updated = new Map(previous);
            updated.delete(id);
            return updated;
          });
          showToast(t('optimizeUndone'));
          return;
        }
        setSegmentUndo((previous) => {
          if (!previous.has(id)) return previous;
          const updated = new Map(previous);
          updated.delete(id);
          return updated;
        });
      };

      /** Improve only the checked segments; identical text is answered from cache. */
      const optimizeSelectedSegments = async () => {
        if (optimizeBatchRef.current) return;
        const ids = new Set(selectedRef.current);
        const targets = segmentsRef.current.filter((segment) =>
          segment.archived !== true && ids.has(segment.id) && segment.text.trim() !== '');
        if (targets.length === 0) {
          showToast(t('optimizeEmpty'));
          return;
        }
        optimizeBatchRef.current = true;
        const snapshot = segmentsRef.current;
        // Selections are captured up front: committing one card re-renders the
        // list, but the other cards keep their own untouched text.
        const plans = targets.map((segment) => ({ segment, selection: selectionRangeFor(segment) }));
        let done = 0;
        let changed = 0;
        let failed = 0;
        let lastSelection = null;
        setOptimizeBatch({ done, total: plans.length });
        try {
          for (const plan of plans) {
            const current = segmentsRef.current.find((segment) =>
              segment.id === plan.segment.id && segment.archived !== true);
            if (current !== undefined && current.text === plan.segment.text) {
              markOptimizing(plan.segment.id, true);
              try {
                const selection = plan.selection;
                const source = selection === null
                  ? current.text
                  : current.text.slice(selection.start, selection.end);
                if (source.trim() !== '') {
                  const title = selection === null ? (current.title ?? '') : '';
                  const value = await requestOptimization(source, title);
                  if (segmentsRef.current.find((segment) => segment.id === current.id)?.text !== current.text) {
                    /* edited while waiting: skip this card */
                  } else {
                    const nextText = selection === null
                      ? value
                      : `${current.text.slice(0, selection.start)}${value}${current.text.slice(selection.end)}`;
                    if (nextText !== current.text) {
                      commitSegments(segmentsRef.current.map((segment) =>
                        (segment.id === current.id ? { ...segment, text: nextText } : segment)));
                      setSegmentUndo((previous) => {
                        const updated = new Map(previous);
                        updated.set(current.id, {
                          before: current.text,
                          after: nextText,
                          selection: selection === null ? null : { ...selection },
                          afterSelection: selection === null
                            ? null
                            : { start: selection.start, end: selection.start + value.length },
                        });
                        return updated;
                      });
                      if (selection !== null) {
                        lastSelection = {
                          id: current.id,
                          start: selection.start,
                          end: selection.start + value.length,
                        };
                      }
                      changed += 1;
                    }
                  }
                }
              } catch {
                failed += 1;
              } finally {
                markOptimizing(plan.segment.id, false);
              }
            }
            done += 1;
            setOptimizeBatch({ done, total: plans.length });
          }
          if (lastSelection !== null) pendingSelectionRef.current = lastSelection;
          if (changed > 0) {
            setBatchUndoState({ snapshot });
            showToast(t('optimizedCount', { n: changed }));
          } else {
            showToast(failed > 0 ? t('optimizeFailed') : t('optimizedToast'));
          }
        } finally {
          optimizeBatchRef.current = false;
          setOptimizeBatch(null);
        }
      };

      const undoBatchOptimization = () => {
        const record = batchUndoRef.current;
        if (record === null || record === undefined) return;
        setBatchUndoState(null);
        setSegmentUndo(new Map());
        commitSegments(record.snapshot);
        showToast(t('optimizeUndone'));
      };

      // Selection -----------------------------------------------------------
      const toggleSelected = (id) => {
        const next = new Set(selectedRef.current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelection(next);
      };

      const toggleSelectAll = () => {
        const active = segmentsRef.current.filter((segment) => segment.archived !== true);
        const allSelected = active.length > 0 && active.every((segment) => selectedRef.current.has(segment.id));
        setSelection(allSelected ? new Set() : new Set(active.map((segment) => segment.id)));
      };

      // Collapse / expand ---------------------------------------------------
      const toggleCollapsed = (id) => {
        const next = new Set(collapsedRef.current);
        if (next.has(id)) next.delete(id);
        else {
          next.add(id);
          if (textSelectionRef.current?.id === id) setTextSelectionState(null);
        }
        syncCollapsed(next);
      };

      const collapseAllSegments = () => {
        const next = new Set(
          segmentsRef.current.map((segment) => segment.id),
        );
        syncCollapsed(next);
      };

      const expandAllSegments = () => {
        syncCollapsed(new Set());
      };

      // Text selection inside a card (AI optimizes only that range) ---------
      const captureTextSelection = (id) => {
        const element = textareaRefs.current.get(id);
        if (element === null || element === undefined) return;
        const start = typeof element.selectionStart === 'number' ? element.selectionStart : 0;
        const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start;
        if (start === end) {
          if (textSelectionRef.current?.id === id) setTextSelectionState(null);
          return;
        }
        setTextSelectionState({ id, start: Math.min(start, end), end: Math.max(start, end) });
      };

      // Segment / selection copy -------------------------------------------
      const copySegments = async (list) => {
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        showToast((await copyText(value)) ? t('copied') : t('copyFailed'));
      };

      const copySelectedSegments = () => {
        const active = segmentsRef.current.filter((segment) => segment.archived !== true);
        const chosen = selectedRef.current.size > 0
          ? active.filter((segment) => selectedRef.current.has(segment.id))
          : active;
        copySegments(chosen);
      };

      // Composer actions ----------------------------------------------------
      const insertValue = (value) => {
        const actions = inputActionsRef.current;
        if (actions === null || actions === undefined) return false;
        if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false;
        const before = readDraftText();
        try {
          const span = actions.captureInsertion();
          if (actions.insertText(value, span) === true) {
            recordComposerHistory(before, readDraftText());
            actions.persistDraft?.();
            return true;
          }
        } catch {
          /* fall through to copy */
        }
        return false;
      };

      const replaceValue = (value) => {
        const actions = inputActionsRef.current;
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') return false;
        const before = readDraftText();
        try {
          actions.setDraft(value);
          recordComposerHistory(before, readDraftText());
          actions.persistDraft?.();
          return true;
        } catch {
          return false;
        }
      };

      const insertSegments = async (list) => {
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        if (insertValue(value)) {
          showToast(t('inserted'));
          return;
        }
        const copied = await copyText(value);
        showToast(copied ? t('insertUnavailable') : t('copyFailed'));
      };

      /** Start a new session in this workspace with the text already in its composer. */
      const insertNewSession = async (list) => {
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        const uiWorkspace = ctx.get('uiWorkspace');
        if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.startSession === 'function') {
          try {
            if (dirtyRef.current) await saveNowRef.current?.({ force: true });
            uiWorkspace.startSession(undefined, { prompt: value, clearPreviousDraft: true });
            showToast(t('insertNewDone'));
            return;
          } catch {
            /* Fall through to copy. */
          }
        }
        const copied = await copyText(value);
        showToast(copied ? t('insertNewUnavailable') : t('copyFailed'));
      };

      const replaceSegments = async (list) => {
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        if (replaceValue(value)) {
          showToast(t('replaced'));
          return;
        }
        const copied = await copyText(value);
        showToast(copied ? t('replaceUnavailable') : t('copyFailed'));
      };

      /** Resolve queue vs steer exactly like the composer's Send button. */
      const resolveSendMode = (sessionId) => {
        try {
          const sessions = ctx.get('sessions');
          const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
          if (row?.running !== true) return 'queue';
        } catch {
          return 'queue';
        }
        return busyEnterPreference(ctx);
      };

      /** Send through the session face with an explicit queue/steer mode. */
      const promptSession = async (sessionId, value, mode) => {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return false;
        const liveBinding = sessions.binding(sessionId);
        const session = liveBinding?.session;
        if (session === undefined || session === null || typeof session.prompt !== 'function') return false;
        let echo;
        try {
          echo = typeof session.beginSubmission === 'function'
            ? session.beginSubmission({ mode, text: value, attachments: [] })
            : undefined;
        } catch {
          echo = undefined;
        }
        try {
          const result = await session.prompt([{ type: 'text', text: value }], mode, undefined, echo?.requestId);
          if (result !== undefined && result !== null && result.ok === false) {
            const failure = new Error(result.error?.message ?? 'prompt failed');
            failure.code = result.error?.code;
            throw failure;
          }
          return true;
        } catch (reason) {
          try {
            echo?.abandon?.();
          } catch {
            /* ignore */
          }
          throw reason;
        }
      };

      /**
       * Send text into a session. Queue prefers the documented scoped conversation
       * service; steer and its fallback go through the session face. The delivery
       * mode follows the General Settings "send while busy" preference.
       * @returns {Promise<boolean>} whether a prompt was accepted
       */
      const sendToSession = async (value, targetSessionId) => {
        const sessionId = typeof targetSessionId === 'string' && targetSessionId !== ''
          ? targetSessionId
          : (rootSessionRef.current !== '' ? rootSessionRef.current : bindingRef.current?.id);
        if (typeof sessionId !== 'string' || sessionId === '') return false;
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null) return false;
        const mode = resolveSendMode(sessionId);
        let scoped;
        if (typeof sessions.scope === 'function') {
          try {
            scoped = sessions.scope(sessionId);
          } catch {
            scoped = undefined;
          }
        }
        const conversation = scoped === undefined || scoped === null
          ? undefined
          : typeof scoped.get === 'function' ? scoped.get('conversation') : scoped.conversation;
        if (mode === 'queue' && conversation !== undefined && conversation !== null
          && typeof conversation.send === 'function') {
          await conversation.send(value);
          return true;
        }
        try {
          return await promptSession(sessionId, value, mode);
        } catch (reason) {
          if (mode === 'steer' && reason?.code === 'session/steer-unavailable') {
            if (conversation !== undefined && conversation !== null && typeof conversation.send === 'function') {
              await conversation.send(value);
              return true;
            }
            return promptSession(sessionId, value, 'queue');
          }
          throw reason;
        }
      };

      /**
       * `sessions.create` only records a placeholder summary; the live Session
       * (and its prompt face) appears after the session is opened. Poll briefly
       * instead of assuming binding() is immediately available — this was why
       * "send into a new session" reported the send interface as unavailable.
       */
      const waitForSessionBinding = async (sessionId, timeoutMs = 3000) => {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null || typeof sessions.binding !== 'function') return false;
        const deadline = Date.now() + Math.max(200, timeoutMs);
        while (Date.now() < deadline) {
          try {
            const live = sessions.binding(sessionId)?.session;
            if (live !== undefined && live !== null && typeof live.prompt === 'function') return true;
          } catch {
            /* Binding may throw while the main view is switching. */
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };

      /** Wait until the notepad has reloaded the same workspace note after a switch. */
      const waitForNoteIds = async (ids, timeoutMs = 500) => {
        const deadline = Date.now() + Math.max(200, timeoutMs);
        while (Date.now() < deadline) {
          if (segmentsRef.current.some((segment) => ids.has(segment.id))) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };

      const sendSegments = async (list) => {
        if (sendingRef.current) return;
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        sendingRef.current = true;
        setSending(true);
        const targetRoot = rootRef.current;
        const targetSession = rootSessionRef.current;
        try {
          const accepted = await sendToSession(value);
          if (accepted !== true) {
            if (!insertValue(value)) await copyText(value);
            showToast(t('sendUnavailable'));
            return;
          }
          showToast(t('sent'));
          const ids = new Set(
            list.filter((segment) => segment.archived !== true).map((segment) => segment.id),
          );
          const stillHere = rootRef.current === targetRoot && rootSessionRef.current === targetSession;
          if (ids.size > 0 && stillHere) {
            const archivedAt = new Date().toISOString();
            const next = segmentsRef.current.map((segment) =>
              (ids.has(segment.id)
                ? { ...segment, archived: true, archivedAt, origin: ARCHIVE_ORIGIN.send }
                : segment));
            setSelection(new Set([...selectedRef.current].filter((id) => !ids.has(id))));
            setArchiveCollapse(ids, ARCHIVE_ORIGIN.send);
            // A send is irreversible and never an undo / redo step.
            commitSegments(next, { record: false });
          }
        } catch (reason) {
          showToast(`${t('sendFailed')}: ${String(reason?.message ?? reason)}`);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      /** Read the Workspace projection, tolerating a Host or service that is not up yet. */
      const workspaceSnapshot = () => {
        try {
          const workspaces = ctx.get('workspaces');
          const snapshot = workspaces?.list?.getSnapshot?.();
          if (snapshot !== undefined && snapshot !== null) return snapshot;
        } catch {
          /* The Workspace follow stream may still be opening. */
        }
        return undefined;
      };

      /**
       * Resolve the registered Workspace that owns `cwd`.
       * `sessions.create` only attaches the new Session to a Workspace when the
       * request names its id; creating with a bare `cwd` leaves the Session in the
       * Ungrouped bucket even though its working directory matches a Workspace.
       * @param cwd - directory the new Session should work in.
       * @param sessionId - Session the note currently reads; its membership is
       *   authoritative when path spellings differ (symlinks, mapped drives).
       * @returns the owning Workspace id, or null when no Workspace claims it.
       */
      const workspaceIdForCwd = async (cwd, sessionId) => {
        const target = normalizedCwd(cwd);
        if (target === '') return null;
        // Windows drive / UNC spellings are case-insensitive; POSIX ones are not.
        const windows = /^[A-Za-z]:\//u.test(target) || target.startsWith('//');
        const wanted = windows ? target.toLowerCase() : target;
        const matches = (path) => {
          const candidate = normalizedCwd(path);
          return (windows ? candidate.toLowerCase() : candidate) === wanted;
        };
        const owner = (items) => {
          if (typeof sessionId === 'string' && sessionId !== '') {
            const member = items.find((item) =>
              (Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)));
            if (typeof member?.workspaceId === 'string' && member.workspaceId !== '') return member.workspaceId;
          }
          const match = items.find((item) => typeof item?.path === 'string' && matches(item.path));
          return typeof match?.workspaceId === 'string' && match.workspaceId !== '' ? match.workspaceId : undefined;
        };
        // A freshly opened Host may still be streaming its Workspace list; wait
        // for the ready baseline so a slow stream does not cost the attachment.
        // A missing service is not worth that wait: it will fall back to `cwd`.
        const start = Date.now();
        let seen = false;
        for (;;) {
          const snapshot = workspaceSnapshot();
          if (snapshot !== undefined) seen = true;
          const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
          const workspaceId = owner(items);
          if (workspaceId !== undefined) return workspaceId;
          // A ready snapshot keeps its current views, so an absent match is final.
          if (snapshot?.phase === 'ready') return null;
          if (!seen && Date.now() - start >= 300) return null;
          if (Date.now() - start >= 1500) return null;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      /** Create an empty session in a workspace and return its id. */
      const createWorkspaceSession = async (cwd, sessionId) => {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null || typeof sessions.create !== 'function') return null;
        const workspaceId = await workspaceIdForCwd(cwd, sessionId);
        const result = await sessions.create(workspaceId !== null ? { workspaceId } : { cwd });
        if (result === undefined || result === null) return null;
        if (result.ok === false) {
          // Publication precedes Workspace attachment: a failed attach still
          // leaves a real Session, and sending into that one beats creating a
          // second Ungrouped Session.
          const published = result.error?.code === 'session/workspace-attach-failed'
            ? result.error?.details?.sessionId
            : undefined;
          if (typeof published === 'string' && published !== '') return published;
          const failure = new Error(result.error?.message ?? 'create session failed');
          failure.code = result.error?.code;
          throw failure;
        }
        const id = result.value?.sessionId ?? result.sessionId
          ?? (typeof result === 'string' ? result : undefined);
        return typeof id === 'string' && id !== '' ? id : null;
      };

      /** Start a fresh session, send the text there, then switch to it. */
      const sendNewSession = async (list) => {
        if (sendingRef.current) return;
        const value = mergedText(list);
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        const cwd = bindingRef.current?.cwd ?? rootRef.current;
        if (cwd === '') {
          showToast(t('sendNewUnavailable'));
          return;
        }
        sendingRef.current = true;
        setSending(true);
        const targetRoot = rootRef.current;
        const targetSession = rootSessionRef.current;
        const snapshot = segmentsRef.current;
        const ids = new Set(
          list.filter((segment) => segment.archived !== true).map((segment) => segment.id),
        );
        let archived = false;
        /** Undo the pre-send archive when the new session never accepts the prompt. */
        const restoreArchived = async () => {
          if (!archived || ids.size === 0) return;
          await waitForNoteIds(ids);
          const current = segmentsRef.current;
          if (rootRef.current === targetRoot
            && current.some((segment) => ids.has(segment.id) && segment.archived === true)) {
            const restored = current.map((segment) =>
              (ids.has(segment.id) && segment.archived === true
                ? { ...segment, archived: false, archivedAt: null, origin: null }
                : segment));
            commitSegments(restored, { record: false });
            await saveNowRef.current?.({ force: true });
            reloadRef.current?.();
            return;
          }
          // The reload did not expose the cards; write the pre-send snapshot
          // back to the old note so nothing is lost.
          if (targetRoot === '' || targetSession === '') return;
          const restored = snapshot.map((segment) =>
            (ids.has(segment.id) ? { ...segment, archived: false, archivedAt: null, origin: null } : segment));
          try {
            await saveNote(targetRoot, targetSession, serializeSegments(restored));
            reloadRef.current?.();
          } catch {
            /* Keep the caller's fallback toast. */
          }
        };
        try {
          const newSessionId = await createWorkspaceSession(
            cwd,
            rootSessionRef.current !== '' ? rootSessionRef.current : bindingRef.current?.id,
          );
          if (newSessionId === null) {
            if (!insertValue(value)) await copyText(value);
            showToast(t('sendNewUnavailable'));
            return;
          }
          // Archive first, while the old binding still owns the note: switching
          // to the new session reloads the same workspace file and could wipe
          // archive changes committed during a race with that load.
          if (ids.size > 0) {
            const archivedAt = new Date().toISOString();
            const next = segmentsRef.current.map((segment) =>
              (ids.has(segment.id)
                ? { ...segment, archived: true, archivedAt, origin: ARCHIVE_ORIGIN.send }
                : segment));
            setSelection(new Set([...selectedRef.current].filter((id) => !ids.has(id))));
            setArchiveCollapse(ids, ARCHIVE_ORIGIN.send);
            // A send is irreversible and never an undo / redo step.
            commitSegments(next, { record: false });
            await saveNowRef.current?.({ force: true });
            archived = true;
          }
          // Open the blank session: create() only records a placeholder and
          // does not attach a live Session, so its prompt face is unavailable
          // until the main view activates it.
          const uiWorkspace = ctx.get('uiWorkspace');
          if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function') {
            uiWorkspace.openSession(newSessionId);
          }
          let accepted = false;
          if (await waitForSessionBinding(newSessionId)) {
            try {
              accepted = await promptSession(newSessionId, value, 'queue');
            } catch {
              accepted = false;
            }
            if (!accepted) {
              try {
                accepted = await sendToSession(value, newSessionId);
              } catch {
                accepted = false;
              }
            }
          }
          if (accepted !== true) {
            await restoreArchived();
            if (!insertValue(value)) await copyText(value);
            showToast(t('sendUnavailable'));
            return;
          }
          showToast(t('sendNewDone'));
        } catch (reason) {
          await restoreArchived();
          showToast(`${t('sendFailed')}: ${String(reason?.message ?? reason)}`);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      const copyAll = async () => {
        // Copy only active work: archived segments were already sent or filed
        // away and must not leak back into a copy-all.
        await copySegments(segmentsRef.current.filter((segment) => segment.archived !== true));
      };

      /**
       * Mirror one successful composer send into the current workspace archive.
       * The same content is never stored twice, whether it is still active or
       * already archived. A captured message starts folded so an automatic
       * entry does not dominate the archive; manual archives and notepad sends
       * stay expanded.
       * @param {any} session Session passed to conversation.sendSession
       * @param {string} text serialized composer message
       */
      const archiveComposerMessage = async (session, text) => {
        const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
        if (sessionId === '' || rootSessionRef.current !== sessionId) return;
        const value = contentKey(text);
        if (value === '') return;
        if (text.length > MAX_SEGMENT_CHARS) {
          console.warn('[dsh-notepad] archive-after-send skipped: message is too large');
          return;
        }
        const targetRoot = rootRef.current;
        if (targetRoot === '') return;
        // A send can settle while the note is still loading; wait for the
        // current root so the appended card is not overwritten by that load.
        const deadline = Date.now() + 4000;
        while (!loadedRef.current && Date.now() < deadline) {
          if (rootRef.current !== targetRoot || rootSessionRef.current !== sessionId) return;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        if (!loadedRef.current || rootRef.current !== targetRoot || rootSessionRef.current !== sessionId) return;
        const current = segmentsRef.current;
        if (current.some((segment) => contentKey(segment.text) === value)) return;
        if (current.length >= MAX_SEGMENTS) {
          console.warn('[dsh-notepad] archive-after-send skipped: segment limit reached');
          return;
        }
        const segment = {
          ...newSegment(text),
          archived: true,
          archivedAt: nowIso(),
          origin: ARCHIVE_ORIGIN.compose,
        };
        const nextCollapsed = new Set(collapsedRef.current);
        nextCollapsed.add(segment.id);
        collapseSeenRef.current.add(segment.id);
        syncCollapsed(nextCollapsed);
        // The capture belongs to a send, so it is never an undo / redo step;
        // `keepSentCards` keeps the archived card out of reach of older steps.
        commitSegments([...current, segment], { record: false });
        // Auto-capture is a persistence promise, not a draft: commit it even in
        // manual save mode. Other unsaved edits ride along through the same PUT.
        await saveNowRef.current?.({ force: true });
      };
      composerSendRef.current = archiveComposerMessage;

      // UI actions ----------------------------------------------------------
      const toggleCollapse = () => {
        setUi((previous) => clampUi({ ...previous, minimized: !previous.minimized }));
      };

      const toggleHidden = () => {
        setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
      };

      const manualSave = async () => {
        await saveNowRef.current?.({ force: true });
        showToast(t('savedToast'));
      };

      /** Persist the buffered note, then open a blank session in that workspace. */
      const switchWorkspace = async (workspace) => {
        setWsOpen(false);
        if (workspace === null || workspace === undefined || workspace.id === currentWsId) return;
        const uiWorkspace = ctx.get('uiWorkspace');
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.startSession !== 'function') {
          showToast(t('switchWorkspaceFailed'));
          return;
        }
        try {
          if (dirtyRef.current) await saveNowRef.current?.({ force: true });
          uiWorkspace.startSession(workspace.id, { clearPreviousDraft: true });
          showToast(t('switchWorkspace'));
        } catch {
          showToast(t('switchWorkspaceFailed'));
        }
      };

      const toggleArchive = () => {
        setUi((previous) => ({ ...previous, showArchive: previous.showArchive !== true }));
      };

      const onSegmentChange = (event, id) => {
        const target = event.currentTarget ?? event.target;
        growTextarea(target);
        updateSegmentText(id, event.target?.value ?? '');
      };

      /** Focus a card's textarea and place the caret at an absolute offset. */
      const focusSegmentAt = (id, caret) => {
        const element = textareaRefs.current.get(id);
        if (element === null || element === undefined) return false;
        try {
          element.focus?.({ preventScroll: true });
        } catch {
          try {
            element.focus?.();
          } catch {
            /* ignore */
          }
        }
        try {
          const value = typeof element.value === 'string' ? element.value : '';
          const position = Math.max(0, Math.min(Number(caret) || 0, value.length));
          if (typeof element.setSelectionRange === 'function') element.setSelectionRange(position, position);
        } catch {
          /* A non-layout shim may not support ranges. */
        }
        try {
          element.scrollIntoView?.({ block: 'nearest' });
        } catch {
          /* ignore */
        }
        return true;
      };

      /** Remove a content-empty segment and keep a nearby typing surface. */
      const deleteEmptySegment = (id, previous, next) => {
        // Backspace deletion goes through the same leave animation as the
        // delete button so the card does not disappear abruptly.
        scheduleLeave([id], 'delete', () => {
          const remaining = segmentsRef.current.filter((segment) => segment.id !== id);
          const activeRemaining = remaining.filter((segment) => segment.archived !== true);
          if (activeRemaining.length === 0) {
            const fresh = newSegment('');
            // Keep archived cards: deleting the last active card used to write
            // [fresh] and silently wipe the whole archive.
            commitSegments([...remaining, fresh], { focus: { id: fresh.id, caret: 0 } });
            return;
          }
          const focus = previous ?? next;
          if (focus === undefined) {
            commitSegments(remaining);
            return;
          }
          const caret = previous !== undefined ? previous.text.length : 0;
          commitSegments(remaining, { focus: { id: focus.id, caret } });
        });
      };

      /** Backspace at position 0 joins this segment onto the previous card. */
      const mergeWithPrevious = (previous, current) => {
        const title = [previous.title, current.title]
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value !== '')
          .join(' · ')
          .slice(0, MAX_TITLE_CHARS);
        const merged = {
          ...previous,
          text: `${previous.text}${current.text}`,
          title,
          images: collectImages([previous, current]),
        };
        const next = segmentsRef.current
          .filter((segment) => segment.id !== current.id)
          .map((segment) => (segment.id === previous.id ? merged : segment));
        commitSegments(next, { focus: { id: previous.id, caret: previous.text.length } });
      };

      const onSegmentKeyDown = (event, id) => {
        if (event.isComposing === true || event.nativeEvent?.isComposing === true) return;
        const chord = event.ctrlKey || event.metaKey;
        if (chord && event.key === 'Enter') {
          event.preventDefault();
          const current = segmentsRef.current.find((segment) => segment.id === id);
          if (current === undefined) return;
          const active = segmentsRef.current.filter((segment) => segment.archived !== true);
          const list = selectedRef.current.size > 0
            ? active.filter((segment) => selectedRef.current.has(segment.id))
            : [current];
          insertSegments(list);
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          if (event.altKey || event.shiftKey || chord) return;
          const element = event.currentTarget ?? event.target;
          const value = typeof element?.value === 'string' ? element.value : '';
          const start = typeof element?.selectionStart === 'number' ? element.selectionStart : null;
          const end = typeof element?.selectionEnd === 'number' ? element.selectionEnd : start;
          if (start === null || start !== end) return;
          // Leave the card only from the very start (Up) or the very end
          // (Down) of its text. The caret line does not matter: a multi-line
          // segment keeps the arrows for its own caret, and a long soft-wrapped
          // line does not jump away just because it wraps.
          const up = event.key === 'ArrowUp';
          const atEdge = up ? start === 0 : start >= value.length;
          if (!atEdge) return;
          const active = segmentsRef.current.filter((segment) => segment.archived !== true);
          const position = active.findIndex((segment) => segment.id === id);
          const neighbor = position < 0 ? undefined : active[position + (up ? -1 : 1)];
          if (neighbor !== undefined && focusSegmentAt(neighbor.id, up ? neighbor.text.length : 0)) {
            event.preventDefault?.();
          }
          return;
        }
        if (event.key === 'Backspace') {
          if (event.altKey || event.shiftKey || chord) return;
          const element = event.currentTarget ?? event.target;
          const start = typeof element?.selectionStart === 'number' ? element.selectionStart : null;
          const end = typeof element?.selectionEnd === 'number' ? element.selectionEnd : start;
          if (start !== 0 || end !== 0) return;
          const active = segmentsRef.current.filter((segment) => segment.archived !== true);
          const position = active.findIndex((segment) => segment.id === id);
          const current = position < 0 ? undefined : active[position];
          if (current === undefined) return;
          const previous = position > 0 ? active[position - 1] : undefined;
          if (isEmptySegment(current)) {
            event.preventDefault?.();
            try {
              event.currentTarget?.blur?.();
            } catch {
              /* A non-layout shim may not expose blur. */
            }
            deleteEmptySegment(current.id, previous, active[position + 1]);
            return;
          }
          if (previous === undefined) return;
          event.preventDefault?.();
          mergeWithPrevious(previous, current);
          return;
        }
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || chord) return;
        event.preventDefault();
        splitSegment(id, event.currentTarget ?? event.target);
      };

      const onHeaderPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        if (target !== null && typeof target?.closest === 'function' && target.closest('button') !== null) return;
        if (typeof ui.x !== 'number' || typeof ui.y !== 'number') return;
        const start = { px: event.clientX, py: event.clientY, x: ui.x, y: ui.y };
        dragRef.current = start;
        const move = (moveEvent) => {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const height = ui.minimized ? HEAD_H : ui.height;
          const minY = hostChromeTop() + EDGE_GAP;
          const x = Math.min(Math.max(EDGE_GAP, start.x + moveEvent.clientX - start.px),
            Math.max(EDGE_GAP, vw - ui.width - EDGE_GAP));
          const y = Math.min(Math.max(minY, start.y + moveEvent.clientY - start.py),
            Math.max(minY, vh - height - EDGE_GAP));
          setUi((previous) => ({ ...previous, x, y }));
        };
        const stop = () => {
          dragRef.current = null;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
        event.preventDefault?.();
      };

      const onResizePointerDown = (event) => {
        if (ui.minimized) return;
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault?.();
        event?.stopPropagation?.();
        const start = { px: event.clientX, py: event.clientY, width: ui.width, height: ui.height };
        resizeRef.current = start;
        setResizing(true);
        const move = (moveEvent) => {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const minY = hostChromeTop() + EDGE_GAP;
          const width = Math.min(Math.max(MIN_W, start.width + moveEvent.clientX - start.px),
            Math.max(MIN_W, vw - EDGE_GAP * 2));
          const height = Math.min(Math.max(MIN_H, start.height + moveEvent.clientY - start.py),
            Math.max(MIN_H, vh - minY - EDGE_GAP));
          setUi((previous) => {
            const maxX = Math.max(EDGE_GAP, vw - width - EDGE_GAP);
            const maxY = Math.max(minY, vh - height - EDGE_GAP);
            return {
              ...previous,
              width,
              height,
              x: typeof previous.x === 'number' ? Math.min(Math.max(EDGE_GAP, previous.x), maxX) : previous.x,
              y: typeof previous.y === 'number' ? Math.min(Math.max(minY, previous.y), maxY) : previous.y,
            };
          });
        };
        const stop = () => {
          resizeRef.current = null;
          setResizing(false);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      };

      // Mirror composer sends into the workspace archive --------------------
      useEffect(() => {
        let disposed = false;
        let patch = null;
        let retry = 0;
        const listener = (session, text) => {
          const handler = composerSendRef.current;
          if (handler !== null && handler !== undefined) handler(session, text);
        };
        const attach = () => {
          patch = installComposerSendPatch(ctx);
          if (patch === null) return false;
          patch.listeners.add(listener);
          return true;
        };
        if (!attach() && typeof setInterval === 'function') {
          // The conversation service is normally ready before the overlay
          // mounts; keep the fallback so a late-provided service still hooks.
          retry = setInterval(() => {
            if (disposed) return;
            if (attach()) {
              clearInterval(retry);
              retry = 0;
            }
          }, 500);
        }
        return () => {
          disposed = true;
          if (retry) clearInterval(retry);
          if (patch !== null) patch.listeners.delete(listener);
        };
      }, []);

      // Render --------------------------------------------------------------
      if (binding === null || present !== true) return null;

      const activeSegments = segments.filter((segment) => segment.archived !== true);
      // Newest archive first: archivedAt is the true ordering, the array order
      // is only a fallback for notes archived by an older build.
      const archivedSegments = segments
        .filter((segment) => segment.archived === true)
        .slice()
        .sort((a, b) => {
          const left = Date.parse(a.archivedAt ?? '') || 0;
          const right = Date.parse(b.archivedAt ?? '') || 0;
          return right - left;
        });
      const selectedActive = activeSegments.filter((segment) => selected.has(segment.id));
      const selectedCount = selectedActive.length;
      const allSelected = activeSegments.length > 0 && selectedCount === activeSegments.length;
      const unsentCount = countUnsent(segments);
      const totalChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
      const activeHasContent = activeSegments.some((segment) =>
        segment.text.trim() !== ''
        || (Array.isArray(segment.images) && segment.images.length > 0));
      const canUndo = historyRef.current.index > 0;
      const canRedo = historyRef.current.index < historyRef.current.entries.length;
      const currentPathKey = workspacePathKey(binding.cwd);
      // Only workspaces whose note actually contains a non-empty segment.
      const workspaceItems = wsList.filter((workspace) => workspace.hasContent === true);
      const liveCurrentHasContent = segments.some((segment) =>
        segment.archived !== true
        && ((typeof segment.text === 'string' && segment.text.trim() !== '')
          || (Array.isArray(segment.images) && segment.images.length > 0)));
      if (liveCurrentHasContent && !workspaceItems.some((workspace) => workspacePathKey(workspace.path) === currentPathKey)) {
        workspaceItems.unshift({
          id: currentWsId,
          path: binding.cwd,
          title: workspaceName(binding.cwd),
          count: unsentCount,
          hasContent: true,
        });
      }
      const displayWidth = ui.width;
      const displayHeight = ui.minimized ? HEAD_H : ui.height;
      const fallbackX = Math.max(EDGE_GAP, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - displayWidth - 24);
      const fallbackY = Math.max(hostChromeTop() + EDGE_GAP,
        ((typeof window !== 'undefined' && window.innerHeight) || 800) - displayHeight - 24);
      const left = typeof ui.x === 'number' ? ui.x : fallbackX;
      const top = typeof ui.y === 'number' ? ui.y : fallbackY;

      let statusText = '';
      if (status === 'loading') statusText = t('loading');
      else if (status === 'saving') statusText = t('saving');
      else if (status === 'dirty') statusText = t('unsaved');
      else if (status === 'error') statusText = loadFailedRef.current ? t('loadFailed') : t('saveFailed');
      else if (status === 'saved') {
        const clock = clockLabel(savedAt);
        statusText = clock === '' ? t('saved') : `${t('saved')} · ${clock}`;
      } else statusText = t('empty');

      const archiveButtonTitle = ui.showArchive ? t('hideArchive') : t('showArchive');

      const workspaceNode = h(
        'div',
        {
          className: 'dsh-np-ws',
          ref: (element) => {
            wsWrapRef.current = element;
          },
          'data-open': wsOpen ? 'true' : 'false',
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-workspace',
            title: t('workspaceMenu'),
            'aria-label': t('workspaceMenu'),
            'aria-haspopup': 'menu',
            'aria-expanded': wsOpen ? 'true' : 'false',
            onClick: () => setWsOpen((open) => !open),
          },
          h('span', { className: 'dsh-np-ws-name' }, workspaceName(binding.cwd)),
          h(ChevronDownIcon, { size: 11 }),
        ),
        wsOpen
          ? h(
              'div',
              { className: 'dsh-np-ws-menu', role: 'menu' },
              workspaceItems.length === 0
                ? h('div', { className: 'dsh-np-ws-empty' }, t('empty'))
                : workspaceItems.map((workspace) => {
                    const isCurrent = workspace.id !== ''
                      ? workspace.id === currentWsId
                      : workspacePathKey(workspace.path) === currentPathKey;
                    const count = isCurrent && liveCountReady ? unsentCount : workspace.count;
                    return h(
                      'button',
                      {
                        key: workspace.id === '' ? workspace.path : workspace.id,
                        type: 'button',
                        className: 'dsh-np-ws-item',
                        role: 'menuitem',
                        'data-current': isCurrent ? 'true' : 'false',
                        title: workspace.path,
                        onClick: () => switchWorkspace(workspace),
                      },
                      h('span', { className: 'dsh-np-ws-item-name' },
                        workspace.title !== '' ? workspace.title : workspaceName(workspace.path)),
                      count > 0
                        ? h('span', { className: 'dsh-np-ws-item-count' }, String(count))
                        : null,
                    );
                  }),
            )
          : null,
      );

      const header = h(
        'div',
        { className: 'dsh-np-head', onPointerDown: onHeaderPointerDown },
        h('span', { className: 'dsh-np-dot', 'data-state': status }),
        h('span', { className: 'dsh-np-title' }, t('title')),
        workspaceNode,
        h('span', { className: 'dsh-np-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: `${t('undo')} · ${settings.shortcuts.undo}`,
            'aria-label': t('undo'),
            disabled: !canUndo,
            onClick: () => applyHistory('undo'),
          },
          h(UndoIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: `${t('redo')} · ${settings.shortcuts.redo}`,
            'aria-label': t('redo'),
            disabled: !canRedo,
            onClick: () => applyHistory('redo'),
          },
          h(RedoIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: t('copy'),
            'aria-label': t('copy'),
            disabled: activeHasContent !== true,
            onClick: copyAll,
          },
          h(CopyIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            'data-active': ui.showArchive ? 'true' : 'false',
            'aria-pressed': ui.showArchive ? 'true' : 'false',
            title: archiveButtonTitle,
            'aria-label': archiveButtonTitle,
            onClick: toggleArchive,
          },
          h(ArchiveIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: t('addSegment'),
            'aria-label': t('addSegment'),
            onClick: addSegment,
          },
          h(PlusIcon, { size: 16 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: ui.minimized ? t('expand') : t('collapse'),
            'aria-label': ui.minimized ? t('expand') : t('collapse'),
            onClick: toggleCollapse,
          },
          h(ui.minimized ? ChevronsExpandIcon : ChevronsCollapseIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: t('minimize'),
            'aria-label': t('minimize'),
            onClick: toggleHidden,
          },
          h(MinimizeIcon, { size: 15 }),
        ),
      );

      /** One icon that expands into current-session + new-session actions. */
      const actionGroup = ({ size, primary, extra, disabled = false }) => {
        const base = size === 'bar' ? 'dsh-np-btn' : 'dsh-np-segbtn';
        const primaryProps = {
          type: 'button',
          className: base,
          title: primary.title,
          'aria-label': primary.title,
          disabled,
          onClick: (event) => {
            const result = primary.onClick?.(event);
            if (event?.detail > 0) {
              try {
                event?.currentTarget?.blur?.();
              } catch {
                /* ignore */
              }
            }
            return result;
          },
          onPointerUp: (event) => {
            // A mouse click leaves focus on the button, and :focus-within kept
            // the group expanded after the pointer left. Keyboard activation
            // fires no pointerup, so it keeps its focused/open behavior.
            try {
              event?.currentTarget?.blur?.();
            } catch {
              /* ignore */
            }
          },
        };
        if (primary.accent === true) primaryProps['data-accent'] = 'true';
        const extraProps = {
          type: 'button',
          className: `${base} dsh-np-group-extra`,
          title: extra.title,
          'aria-label': extra.title,
          disabled,
          onClick: (event) => {
            const result = extra.onClick?.(event);
            if (event?.detail > 0) {
              try {
                event?.currentTarget?.blur?.();
              } catch {
                /* ignore */
              }
            }
            return result;
          },
          onPointerUp: (event) => {
            try {
              event?.currentTarget?.blur?.();
            } catch {
              /* ignore */
            }
          },
        };
        if (extra.danger === true) extraProps['data-danger'] = 'true';
        return h(
          'div',
          {
            className: 'dsh-np-actiongroup',
            'data-size': size,
            'data-expanded': settings.buttonGroups === false ? 'true' : 'false',
          },
          h('button', primaryProps, primary.icon),
          h('button', extraProps, extra.icon ?? h(NewSessionIcon, { size: 14 })),
        );
      };

      const tools = h(
        'div',
        { className: 'dsh-np-tools' },
        h(
          'label',
          { className: 'dsh-np-selectall', title: t('selectAll') },
          h('input', {
            type: 'checkbox',
            checked: allSelected,
            disabled: activeSegments.length === 0,
            'aria-label': t('selectAll'),
            onChange: toggleSelectAll,
          }),
          h('span', { className: 'dsh-np-selcount' },
            selectedCount > 0 ? t('selected', { n: selectedCount }) : t('selectHint')),
        ),
        h(
          'div',
          { className: 'dsh-np-toolbar-actions' },
          selectedCount > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-np-btn',
                  title: t('clearSelection'),
                  'aria-label': t('clearSelection'),
                  onClick: () => setSelection(new Set()),
                },
                h(CloseIcon, { size: 13 }),
              )
            : null,
          settings.saveMode === 'manual'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-np-btn',
                  title: `${t('saveNowHint')} · ${settings.shortcuts.save}`,
                  'aria-label': t('saveNow'),
                  disabled: status === 'loading' || status === 'saving',
                  onClick: manualSave,
                },
                h(SaveIcon, { size: 14 }),
              )
            : null,
          actionGroup({
            size: 'bar',
            primary: {
              title: t('expandAll'),
              onClick: expandAllSegments,
              icon: h(ChevronsExpandIcon, { size: 14 }),
            },
            extra: {
              title: t('collapseAll'),
              onClick: collapseAllSegments,
              icon: h(ChevronsCollapseIcon, { size: 14 }),
            },
          }),
          selectedCount > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-np-btn',
                  title: t('copySelected', { n: selectedCount }),
                  'aria-label': t('copySelected', { n: selectedCount }),
                  disabled: activeHasContent !== true,
                  onClick: copySelectedSegments,
                },
                h(CopyIcon, { size: 14 }),
              )
            : null,
          actionGroup({
            size: 'bar',
            disabled: selectedCount === 0,
            primary: {
              title: selectedCount > 0 ? t('insertSelected', { n: selectedCount }) : t('insert'),
              onClick: () => insertSegments(selectedActive),
              icon: h(InsertIcon, { size: 14 }),
            },
            extra: {
              title: selectedCount > 0 ? t('insertNewSelected', { n: selectedCount }) : t('insertNewSession'),
              onClick: () => insertNewSession(selectedActive),
              icon: h(NewSessionIcon, { size: 14 }),
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              title: selectedCount > 0 ? t('replaceSelected', { n: selectedCount }) : t('replace'),
              'aria-label': t('replace'),
              disabled: selectedCount === 0,
              onClick: () => replaceSegments(selectedActive),
            },
            h(ReplaceIcon, { size: 14 }),
          ),
          actionGroup({
            size: 'bar',
            disabled: selectedCount === 0 || sending,
            primary: {
              title: selectedCount > 0
                ? (sending ? t('sending') : t('sendSelected', { n: selectedCount }))
                : t('send'),
              onClick: () => sendSegments(selectedActive),
              icon: h(SendIcon, { size: 14 }),
              accent: true,
            },
            extra: {
              title: selectedCount > 0 ? t('sendNewSelected', { n: selectedCount }) : t('sendNewSession'),
              onClick: () => sendNewSession(selectedActive),
              icon: h(NewSessionSendIcon, { size: 14 }),
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              title: selectedCount > 1 ? t('mergeSelected', { n: selectedCount }) : t('mergeHint'),
              'aria-label': t('merge'),
              disabled: selectedCount < 2,
              onClick: mergeSelected,
            },
            h(MergeIcon, { size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              'data-active': optimizeBatch !== null || batchUndo !== null ? 'true' : 'false',
              title: optimizeBatch !== null
                ? t('optimizeAllProgress', { done: optimizeBatch.done, total: optimizeBatch.total })
                : batchUndo !== null
                  ? t('undoOptimize')
                  : selectedCount > 0
                    ? t('optimizeSelected', { n: selectedCount })
                    : t('optimizeSelectHint'),
              'aria-label': batchUndo !== null
                ? t('undoOptimize')
                : selectedCount > 0 ? t('optimizeSelected', { n: selectedCount }) : t('optimizeSelectHint'),
              disabled: optimizeBatch !== null
                || (batchUndo === null && selectedCount === 0),
              onClick: batchUndo !== null ? undoBatchOptimization : optimizeSelectedSegments,
            },
            optimizeBatch !== null
              ? h('span', { className: 'dsh-np-mini-spinner' })
              : batchUndo !== null ? h(UndoIcon, { size: 14 }) : h(SparkleIcon, { size: 14 }),
          ),
          actionGroup({
            size: 'bar',
            disabled: selectedCount === 0,
            primary: {
              title: selectedCount > 0 ? t('archiveSelected', { n: selectedCount }) : t('archive'),
              onClick: archiveSelected,
              icon: h(ArchiveIcon, { size: 14 }),
            },
            extra: {
              title: selectedCount > 0 ? t('deleteSelected', { n: selectedCount }) : t('batchDelete'),
              danger: true,
              onClick: () => setDeleteConfirm('batch'),
              icon: h(TrashIcon, { size: 14 }),
            },
          }),
        ),
      );

      const totalImages = segments.reduce(
        (sum, segment) => sum + (Array.isArray(segment.images) ? segment.images.length : 0), 0);

      const renderMedia = (segment, options = {}) => {
        const images = Array.isArray(segment.images) ? segment.images : [];
        const pending = options.pending === true;
        if (images.length === 0 && !pending) return null;
        return h(
          'div',
          { className: 'dsh-np-medias' },
          pending
            ? h(
                'div',
                { key: 'pending', className: 'dsh-np-img', 'data-pending': 'true' },
                h('span', { className: 'dsh-np-img-spinner' }),
                h('span', { className: 'dsh-np-img-name' }, t('imageUploading')),
              )
            : null,
          images.map((image, imageIndex) => h(
            'div',
            { key: `${imageIndex}-${image.path}`, className: 'dsh-np-img', title: image.path },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-img-open',
                title: `${t('openImage')}: ${image.path}`,
                'aria-label': t('openImage'),
                onClick: () => openImage(image),
              },
              h('img', {
                src: imageUrl(image.path, binding.cwd),
                alt: image.name,
                loading: 'lazy',
                decoding: 'async',
                draggable: false,
              }),
            ),
            options.readOnly === true
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-np-img-remove',
                    title: t('removeImage'),
                    'aria-label': t('removeImage'),
                    onClick: () => removeImage(segment.id, image.path),
                  },
                  h(CloseIcon, { size: 11 }),
                ),
          )),
        );
      };

      /** Stable ref callbacks so React does not re-measure on every render. */
      const textareaRefSetter = (id) => {
        let setter = textareaSettersRef.current.get(id);
        if (setter === undefined) {
          setter = (element) => {
            if (element === null || element === undefined) {
              textareaRefs.current.delete(id);
              textareaSettersRef.current.delete(id);
              return;
            }
            textareaRefs.current.set(id, element);
            growTextarea(element);
          };
          textareaSettersRef.current.set(id, setter);
        }
        return setter;
      };

      const fileInputRefSetter = (id) => {
        let setter = fileInputSettersRef.current.get(id);
        if (setter === undefined) {
          setter = (element) => {
            if (element === null || element === undefined) {
              fileInputRefs.current.delete(id);
              fileInputSettersRef.current.delete(id);
              return;
            }
            fileInputRefs.current.set(id, element);
          };
          fileInputSettersRef.current.set(id, setter);
        }
        return setter;
      };

      const activeCards = activeSegments.map((segment, index) => {
        const images = Array.isArray(segment.images) ? segment.images : [];
        const empty = segment.text.trim() === '' && images.length === 0;
        const titleValue = segment.title ?? '';
        const showTitleInput = titleValue !== '' || titleEditing === segment.id;
        const undoRecord = segmentUndo.get(segment.id);
        const canUndoOptimize = undoRecord !== undefined && undoRecord.after === segment.text;
        const optimizingNow = optimizing.has(segment.id);
        const aiBusy = optimizingNow || optimizeBatch !== null;
        const folded = collapsed.has(segment.id);
        const selection = textSelection !== null && textSelection.id === segment.id
          && segment.text.slice(textSelection.start, textSelection.end).trim() !== ''
          ? textSelection
          : null;
        const optimizedRange = undoRecord?.afterSelection ?? null;
        const selectionIsOptimizedRange = selection !== null && optimizedRange !== null
          && selection.start === optimizedRange.start
          && selection.end === optimizedRange.end;
        const showUndoAi = canUndoOptimize && (selection === null || selectionIsOptimizedRange);
        const aiTitle = aiBusy
          ? t('optimizing')
          : showUndoAi
            ? t('undoOptimize')
            : selection !== null ? t('optimizeSelection') : t('optimizeSegment');
        return h(
          'article',
          {
            key: segment.id,
            className: 'dsh-np-seg',
            'data-seg-id': segment.id,
            'data-archived': 'false',
            'data-selected': selected.has(segment.id) ? 'true' : 'false',
            'data-collapsed': folded ? 'true' : 'false',
            'data-leaving': leaving.has(segment.id) ? 'true' : 'false',
            'data-reorder-drag': reorderDrag === segment.id ? 'true' : 'false',
            'data-drop-before': reorderOver?.id === segment.id && reorderOver?.after === false ? 'true' : 'false',
            'data-drop-after': reorderOver?.id === segment.id && reorderOver?.after === true ? 'true' : 'false',
            onDragOver: (event) => onSegmentReorderOver(event, segment.id),
            onDragLeave: () => {
              if (reorderOverRef.current?.id === segment.id) setReorderTarget(null);
            },
            onDrop: (event) => onSegmentReorderDrop(event, segment.id),
          },
          h('input', {
            key: 'file-input',
            ref: fileInputRefSetter(segment.id),
            className: 'dsh-np-file',
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            multiple: true,
            tabIndex: -1,
            'aria-hidden': 'true',
            onChange: (event) => onFileInputChange(event, segment.id),
          }),
          h(
            'div',
            { className: 'dsh-np-seg-head' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-fold',
                title: folded ? t('expandSegment') : t('collapseSegment'),
                'aria-label': folded ? t('expandSegment') : t('collapseSegment'),
                'aria-expanded': folded ? 'false' : 'true',
                onClick: () => toggleCollapsed(segment.id),
              },
              h(folded ? ChevronRightIcon : ChevronDownIcon, { size: 13 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-index',
                title: t('indexHint'),
                'aria-label': t('selectSegment'),
                'aria-pressed': selected.has(segment.id) ? 'true' : 'false',
                draggable: true,
                onDragStart: (event) => onSegmentReorderStart(event, segment.id),
                onDragEnd: () => {
                  reorderDragRef.current = '';
                  setReorderDrag('');
                  setReorderTarget(null);
                },
                onClick: () => toggleSelected(segment.id),
              },
              String(index + 1).padStart(2, '0'),
            ),
            showTitleInput
              ? h('input', {
                  type: 'text',
                  className: 'dsh-np-title-input',
                  value: titleValue,
                  placeholder: t('titlePlaceholder'),
                  maxLength: MAX_TITLE_CHARS,
                  autoFocus: titleValue === '',
                  'aria-label': t('segmentTitle'),
                  spellCheck: false,
                  onFocus: () => setTitleEditing(segment.id),
                  onChange: (event) => updateSegmentTitle(segment.id, event.target?.value ?? ''),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    try {
                      event.currentTarget?.blur?.();
                    } catch {
                      /* ignore */
                    }
                  },
                  onBlur: () => {
                    flushTextHistory();
                    if (settingsRef.current.saveMode !== 'manual' && dirtyRef.current) saveNowRef.current?.();
                    if ((segment.title ?? '') === '') setTitleEditing('');
                  },
                })
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-np-title-add',
                    title: t('segmentTitle'),
                    'aria-label': t('segmentTitle'),
                    onClick: () => setTitleEditing(segment.id),
                  },
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                title: t('addImage'),
                'aria-label': t('addImage'),
                onClick: () => triggerFilePicker(segment.id),
              },
              h(ImageIcon, { size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                title: t('copySegment'),
                'aria-label': t('copySegment'),
                disabled: empty,
                onClick: () => copySegments([segment]),
              },
              h(CopyIcon, { size: 14 }),
            ),
            actionGroup({
              size: 'card',
              disabled: empty,
              primary: {
                title: t('insertSegment'),
                onClick: () => insertSegments([segment]),
                icon: h(InsertIcon, { size: 14 }),
              },
              extra: {
                title: t('insertNewSession'),
                onClick: () => insertNewSession([segment]),
                icon: h(NewSessionIcon, { size: 14 }),
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                title: t('replaceSegment'),
                'aria-label': t('replaceSegment'),
                disabled: empty,
                onClick: () => replaceSegments([segment]),
              },
              h(ReplaceIcon, { size: 14 }),
            ),
            actionGroup({
              size: 'card',
              disabled: empty || sending,
              primary: {
                title: t('sendSegment'),
                onClick: () => sendSegments([segment]),
                icon: h(SendIcon, { size: 14 }),
              },
              extra: {
                title: t('sendNewSession'),
                onClick: () => sendNewSession([segment]),
                icon: h(NewSessionSendIcon, { size: 14 }),
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                'data-ai': 'true',
                'data-selection': selection === null ? 'false' : 'true',
                title: aiTitle,
                'aria-label': aiTitle,
                disabled: aiBusy || (showUndoAi ? false : segment.text.trim() === ''),
                onClick: showUndoAi
                  ? () => undoOptimizeSegment(segment.id)
                  : () => optimizeSegment(segment.id),
              },
              optimizingNow
                ? h('span', { className: 'dsh-np-mini-spinner' })
                : showUndoAi ? h(UndoIcon, { size: 14 }) : h(SparkleIcon, { size: 14 }),
            ),
            actionGroup({
              size: 'card',
              primary: {
                title: t('archiveSegment'),
                onClick: () => archiveSegment(segment.id),
                icon: h(ArchiveIcon, { size: 14 }),
              },
              extra: {
                title: t('deleteActiveSegment'),
                danger: true,
                onClick: () => {
                  if (isEmptySegment(segment)) deleteActiveSegment(segment.id);
                  else setDeleteConfirm(segment.id);
                },
                icon: h(TrashIcon, { size: 14 }),
              },
            }),
          ),
          folded
            ? h(
                'div',
                { className: 'dsh-np-seg-preview' },
                segment.text.trim() === ''
                  ? (images.length > 0 ? t('images', { n: images.length }) : t('emptySegment'))
                  : segment.text,
              )
            : h(
                'div',
                {
                  className: 'dsh-np-editor',
                  'data-drag': dragSegment === segment.id ? 'true' : 'false',
                  onPaste: (event) => onSegmentPaste(event, segment.id),
                  onDrop: (event) => onSegmentDrop(event, segment.id),
                  onDragOver: (event) => onSegmentDragOver(event, segment.id),
                  onDragLeave: (event) => onSegmentDragLeave(event, segment.id),
                },
                renderMedia(segment, { pending: (uploading[segment.id] ?? 0) > 0 }),
                h('textarea', {
                  ref: textareaRefSetter(segment.id),
                  className: 'dsh-np-seg-text',
                  rows: 1,
                  value: segment.text,
                  placeholder: index === activeSegments.length - 1 ? t('placeholder') : t('segmentPlaceholder'),
                  spellCheck: false,
                  maxLength: MAX_SEGMENT_CHARS,
                  'aria-label': t('editor'),
                  onSelect: () => captureTextSelection(segment.id),
                  onChange: (event) => onSegmentChange(event, segment.id),
                  onKeyDown: (event) => onSegmentKeyDown(event, segment.id),
                  onBlur: () => {
                    flushTextHistory();
                    if (settingsRef.current.saveMode !== 'manual' && dirtyRef.current) saveNowRef.current?.();
                  },
                }),
              ),
        );
      });

      const activeEmpty = activeSegments.length === 0
        ? h(
            'div',
            { key: 'active-empty', className: 'dsh-np-empty' },
            h('span', null, t('noActive')),
            h(
              'button',
              { type: 'button', className: 'dsh-np-empty-add', onClick: addSegment },
              h(PlusIcon, { size: 14 }),
              h('span', null, t('addSegment')),
            ),
          )
        : null;

      const archiveSection = archivedSegments.length > 0 || ui.showArchive
        ? h(
            'div',
            {
              key: 'archive',
              className: 'dsh-np-archive',
              'data-open': ui.showArchive ? 'true' : 'false',
              'aria-hidden': ui.showArchive ? undefined : 'true',
            },
            h(
              'div',
              { className: 'dsh-np-archive-inner' },
              h(
                'div',
                { className: 'dsh-np-archive-head' },
                h(ArchiveIcon, { size: 13 }),
                h('span', { className: 'dsh-np-archive-label' },
                  t('archiveCount', { n: archivedSegments.length })),
                h('span', { className: 'dsh-np-spacer' }),
                archivedSegments.length > 0
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-np-link',
                      title: t('restoreAll'),
                      onClick: restoreAll,
                    }, t('restoreAll'))
                  : null,
                archivedSegments.length > 0
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-np-link',
                      'data-danger': 'true',
                      title: t('clearArchive'),
                      onClick: clearArchive,
                    }, t('clearArchive'))
                  : null,
              ),
              archivedSegments.length === 0
                ? h('div', { className: 'dsh-np-empty-small' }, t('archiveEmpty'))
                : h(
                    'div',
                    {
                      className: 'dsh-np-archive-list',
                      ref: (element) => {
                        archiveListRef.current = element;
                      },
                    },
                    archivedSegments.map((segment) => {
                      const folded = collapsed.has(segment.id);
                      const images = Array.isArray(segment.images) ? segment.images : [];
                      const preview = segment.text.trim() === ''
                        ? (images.length > 0 ? t('images', { n: images.length }) : t('emptySegment'))
                        : segment.text;
                      return h(
                        'article',
                        {
                          key: segment.id,
                          className: 'dsh-np-seg',
                          'data-seg-id': segment.id,
                          'data-archived': 'true',
                          'data-collapsed': folded ? 'true' : 'false',
                          'data-leaving': leaving.has(segment.id) ? 'true' : 'false',
                        },
                        h(
                          'div',
                          { className: 'dsh-np-seg-head' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-fold',
                              title: folded ? t('expandSegment') : t('collapseSegment'),
                              'aria-label': folded ? t('expandSegment') : t('collapseSegment'),
                              'aria-expanded': folded ? 'false' : 'true',
                              onClick: () => toggleCollapsed(segment.id),
                            },
                            h(folded ? ChevronRightIcon : ChevronDownIcon, { size: 13 }),
                          ),
                          h('span', { className: 'dsh-np-archived-chip' }, t('archived')),
                          typeof segment.title === 'string' && segment.title.trim() !== ''
                            ? h('span', { className: 'dsh-np-seg-title' }, segment.title)
                            : null,
                          h('span', { className: 'dsh-np-spacer' }),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-segbtn',
                              title: t('copySegment'),
                              'aria-label': t('copySegment'),
                              disabled: segment.text.trim() === ''
                                && images.length === 0,
                              onClick: () => copySegments([segment]),
                            },
                            h(CopyIcon, { size: 14 }),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-segbtn',
                              title: t('insertSegment'),
                              'aria-label': t('insertSegment'),
                              disabled: segment.text.trim() === ''
                                && images.length === 0,
                              onClick: () => insertSegments([segment]),
                            },
                            h(InsertIcon, { size: 14 }),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-segbtn',
                              title: t('replaceSegment'),
                              'aria-label': t('replaceSegment'),
                              disabled: segment.text.trim() === ''
                                && images.length === 0,
                              onClick: () => replaceSegments([segment]),
                            },
                            h(ReplaceIcon, { size: 14 }),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-segbtn',
                              title: t('restoreSegment'),
                              'aria-label': t('restoreSegment'),
                              onClick: () => restoreSegment(segment.id),
                            },
                            h(RestoreIcon, { size: 14 }),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-np-segbtn',
                              'data-danger': 'true',
                              title: t('deleteSegment'),
                              'aria-label': t('deleteSegment'),
                              onClick: () => deleteArchived(segment.id),
                            },
                            h(TrashIcon, { size: 14 }),
                          ),
                        ),
                        folded
                          ? h('div', { className: 'dsh-np-seg-preview' }, preview)
                          : h('div', { className: 'dsh-np-seg-archived-text' },
                              segment.text === ''
                                ? (images.length > 0 ? null : t('emptySegment'))
                                : segment.text),
                        folded ? null : renderMedia(segment, { readOnly: true }),
                      );
                    }),
                  ),
            ),
          )
        : null;

      const listContent = status === 'loading'
        ? h('div', { key: 'loading', className: 'dsh-np-empty' }, t('loading'))
        : [activeCards, activeEmpty, archiveSection];

      const footer = h(
        'div',
        { className: 'dsh-np-foot' },
        h('span', {
          className: 'dsh-np-status',
          'data-state': status,
          title: error === '' ? undefined : error,
        }, statusText),
        status === 'error'
          ? h('button', {
              type: 'button',
              className: 'dsh-np-retry',
              onClick: () => {
                if (loadFailedRef.current) reloadRef.current?.();
                else saveNowRef.current?.({ force: true });
              },
            }, t('retry'))
          : null,
        h('span', { className: 'dsh-np-count' },
          `${t('chars', { n: totalChars })} · ${t('segments', { n: activeSegments.length })}`
          + (totalImages > 0 ? ` · ${t('images', { n: totalImages })}` : '')),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-hint',
            title: t('hintNext'),
            'aria-label': t('hintNext'),
            onClick: () => setHintIndex((index) => (index + 1) % HINT_KEYS.length),
          },
          t(HINT_KEYS[hintIndex % HINT_KEYS.length]),
        ),
      );

      const toastNode = toast === null
        ? null
        : h(
            'div',
            { className: 'dsh-np-toast', role: 'status' },
            h('span', { className: 'dsh-np-toast-text' }, toast.message),
            toast.action !== null && toast.action !== undefined
              ? h('button', {
                  type: 'button',
                  className: 'dsh-np-toast-action',
                  onClick: toast.action.onClick,
                }, toast.action.label)
              : null,
          );

      const body = h(
        'div',
        {
          className: 'dsh-np-body',
          'aria-hidden': ui.minimized ? 'true' : undefined,
        },
        tools,
        h('div', { className: 'dsh-np-list', ref: listRef }, listContent),
        footer,
        toastNode,
      );

      const resizeHandle = ui.minimized
        ? null
        : h('div', {
            className: 'dsh-np-resize',
            role: 'separator',
            title: t('resize'),
            'aria-label': t('resize'),
            onPointerDown: onResizePointerDown,
          });

      const previewNode = previewImage === null
        ? null
        : h(
            'div',
            {
              className: 'dsh-np-preview',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('imagePreview'),
              onClick: () => setPreviewImage(null),
            },
            h('img', {
              className: 'dsh-np-preview-img',
              src: imageUrl(previewImage.path, binding.cwd),
              alt: previewImage.name,
              onClick: (event) => event?.stopPropagation?.(),
            }),
            h(
              'div',
              { className: 'dsh-np-preview-bar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-np-preview-btn',
                  title: t('openOriginal'),
                  'aria-label': t('openOriginal'),
                  onClick: (event) => {
                    event?.stopPropagation?.();
                    openOriginalImage(previewImage);
                  },
                },
                h(OpenIcon, { size: 15 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-np-preview-btn',
                  title: t('closePreview'),
                  'aria-label': t('closePreview'),
                  onClick: (event) => {
                    event?.stopPropagation?.();
                    setPreviewImage(null);
                  },
                },
                h(CloseIcon, { size: 15 }),
              ),
            ),
            h('div', { className: 'dsh-np-preview-name' }, previewImage.name),
          );

      const batchDelete = deleteConfirm === 'batch' && selectedCount > 0;
      const deleteTarget = deleteConfirm === '' || batchDelete
        ? undefined
        : segments.find((segment) => segment.id === deleteConfirm && segment.archived !== true);
      const confirmCount = batchDelete ? selectedCount : 1;
      const confirmNode = (!batchDelete && deleteTarget === undefined)
        ? null
        : h(
            'div',
            {
              className: 'dsh-np-confirm',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-label': batchDelete ? t('batchDeleteTitle', { n: confirmCount }) : t('deleteConfirmTitle'),
              onClick: () => setDeleteConfirm(''),
            },
            h(
              'div',
              {
                className: 'dsh-np-confirm-card',
                onClick: (event) => event?.stopPropagation?.(),
              },
              h('div', { className: 'dsh-np-confirm-title' },
                batchDelete ? t('batchDeleteTitle', { n: confirmCount }) : t('deleteConfirmTitle')),
              h('div', { className: 'dsh-np-confirm-body' },
                batchDelete ? t('batchDeleteBody') : t('deleteConfirmBody')),
              h('div', { className: 'dsh-np-confirm-hint' },
                batchDelete ? t('batchDeleteHint') : t('deleteConfirmHint')),
              h(
                'div',
                { className: 'dsh-np-confirm-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-np-confirm-btn',
                    onClick: () => setDeleteConfirm(''),
                  },
                  t('deleteConfirmCancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-np-confirm-btn',
                    'data-danger': 'true',
                    onClick: () => {
                      if (batchDelete) deleteSelectedSegments();
                      else if (deleteTarget !== undefined) deleteActiveSegment(deleteTarget.id);
                    },
                  },
                  t('deleteConfirmOk'),
                ),
              ),
            ),
          );

      const card = h(
        'section',
        {
          key: 'card',
          className: 'dsh-np-card',
          'data-dsh-notepad': 'true',
          'data-minimized': ui.minimized ? 'true' : 'false',
          'data-hidden': ui.hidden ? 'true' : 'false',
          'data-resizing': resizing ? 'true' : 'false',
          'data-state': status,
          'data-np-theme': THEME_IDS.includes(settings.theme) ? settings.theme : 'host',
          'data-np-style': settings.uiStyle === 'flat' ? 'flat' : 'glass',
          'aria-hidden': ui.hidden ? 'true' : undefined,
          style: {
            left: `${left}px`,
            top: `${top}px`,
            width: `${displayWidth}px`,
            height: `${displayHeight}px`,
            '--np-seg-max': `${settings.maxSegmentHeight}px`,
            '--np-font-size': `${settings.fontSize}px`,
            '--np-blur': `${settings.blur}px`,
            '--np-group-delay': `${settings.groupDelay}ms`,
            '--np-font': FONT_STACKS[settings.font] ?? FONT_STACK,
          },
          role: 'complementary',
          'aria-label': t('title'),
        },
        header,
        body,
        previewNode,
        confirmNode,
        resizeHandle,
      );

      const restore = h(
        'button',
        {
          key: 'restore',
          type: 'button',
          className: 'dsh-np-restore',
          'data-visible': ui.hidden ? 'true' : 'false',
          'aria-hidden': ui.hidden ? undefined : 'true',
          tabIndex: ui.hidden ? undefined : -1,
          title: t('show', { shortcut: settings.shortcuts.toggle }),
          'aria-label': t('show', { shortcut: settings.shortcuts.toggle }),
          onClick: toggleHidden,
        },
        h(NotepadIcon, { size: 16 }),
        ui.hidden && unsentCount > 0
          ? h('span', {
              className: 'dsh-np-restore-badge',
              title: t('unsent', { n: unsentCount }),
            }, unsentCount > 99 ? '99+' : String(unsentCount))
          : null,
      );

      return [card, restore];
    }

    // ------------------------------------------------------------------
    // Settings tab
    // ------------------------------------------------------------------

    /** Custom dropdown used by the settings tab (native selects cannot be themed). */
    function SettingsDropdown({ value, options, onChange, disabled = false, ariaLabel }) {
      const [open, setOpen] = useState(false);
      const wrapRef = useRef(null);
      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined;
        const close = (event) => {
          const wrap = wrapRef.current;
          if (wrap !== null && wrap !== undefined && typeof wrap.contains === 'function'
            && event?.target !== undefined && wrap.contains(event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event?.key !== 'Escape') return;
          event.preventDefault?.();
          setOpen(false);
        };
        document.addEventListener('pointerdown', close, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', close, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open]);
      const current = options.find((option) => option.value === value) ?? options[0];
      return h(
        'div',
        { className: 'dsh-np-drop', ref: (element) => { wrapRef.current = element; } },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-drop-btn',
            disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': ariaLabel,
            onClick: () => setOpen((previous) => !previous),
          },
          h('span', { className: 'dsh-np-drop-value' }, current?.label ?? ''),
          h(ChevronDownIcon, { size: 13 }),
        ),
        open
          ? h(
              'div',
              { className: 'dsh-np-drop-menu', role: 'listbox' },
              options.map((option) => h(
                'button',
                {
                  key: option.value,
                  type: 'button',
                  className: 'dsh-np-drop-item',
                  role: 'option',
                  'data-active': option.value === value ? 'true' : 'false',
                  'aria-selected': option.value === value ? 'true' : 'false',
                  title: option.description,
                  onClick: () => {
                    setOpen(false);
                    onChange(option.value);
                  },
                },
                h('span', { className: 'dsh-np-drop-value' }, option.label),
                option.value === value ? h('span', { className: 'dsh-np-drop-check' }, '✓') : null,
              )),
            )
          : null,
      );
    }

    /** Track + knob switch, matching the host settings switch tokens. */
    function SettingsToggle({ checked, onChange, label, disabled = false }) {
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-np-toggle${checked ? ' on' : ''}`,
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'dsh-np-toggle-track' }, h('span', { className: 'dsh-np-toggle-knob' })),
        label === undefined ? null : h('span', { className: 'dsh-np-toggle-label' }, label),
      );
    }

    /** Read-only chord field that binds whatever the user presses next. */
    function SettingsKeyField({ value, onCommit, ariaLabel }) {
      const [recording, setRecording] = useState(false);
      useEffect(() => () => {
        shortcutRecording = false;
      }, []);
      return h('input', {
        type: 'text',
        className: 'dsh-np-key',
        readOnly: true,
        value,
        'data-recording': recording ? 'true' : 'false',
        'aria-label': ariaLabel,
        title: ariaLabel,
        onFocus: () => {
          shortcutRecording = true;
          setRecording(true);
        },
        onBlur: () => {
          shortcutRecording = false;
          setRecording(false);
        },
        onKeyDown: (event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            shortcutRecording = false;
            setRecording(false);
            try {
              event.currentTarget?.blur?.();
            } catch {
              /* ignore */
            }
            return;
          }
          const label = shortcutLabelForEvent(event);
          if (label === '' || parseShortcut(label) === null) return;
          event.preventDefault?.();
          onCommit(label);
          shortcutRecording = false;
          setRecording(false);
          try {
            event.currentTarget?.blur?.();
          } catch {
            /* ignore */
          }
        },
      });
    }

    /** Number input with a local draft so typing does not get clamped per key. */
    function SettingsNumber({ value, min, max, onCommit, ariaLabel, disabled = false }) {
      const [draft, setDraft] = useState(String(value));
      useEffect(() => {
        setDraft(String(value));
      }, [value]);
      const commit = () => {
        const number = Number(draft);
        if (!Number.isFinite(number)) {
          setDraft(String(value));
          return;
        }
        const next = clampInt(number, min, max, value);
        setDraft(String(next));
        if (next !== value) onCommit(next);
      };
      return h('input', {
        type: 'number',
        className: 'dsh-np-set-number',
        value: draft,
        min,
        max,
        step: 1,
        disabled,
        'aria-label': ariaLabel,
        onChange: (event) => setDraft(String(event.target?.value ?? '')),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault?.();
          commit();
          try {
            event.currentTarget?.blur?.();
          } catch {
            /* ignore */
          }
        },
      });
    }

    function NotepadSettings({ t }) {
      const [settings, setSettings] = useState(readSettings);
      const [notice, setNotice] = useState('');
      const noticeTimerRef = useRef(0);
      useEffect(() => subscribeSettings((next) => setSettings(next)), []);
      useEffect(() => () => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      }, []);
      const commit = (patch) => {
        const next = writeSettings(patch);
        setSettings(next);
        return next;
      };
      const announce = (message) => {
        setNotice(message);
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setNotice(''), 2200);
      };

      const themeOptions = [
        { value: 'host', label: t('themeHost') },
        { value: 'ocean', label: t('themeOcean') },
        { value: 'violet', label: t('themeViolet') },
        { value: 'emerald', label: t('themeEmerald') },
        { value: 'amber', label: t('themeAmber') },
        { value: 'rose', label: t('themeRose') },
      ];
      const styleOptions = [
        { value: 'flat', label: t('uiFlat') },
        { value: 'glass', label: t('uiGlass') },
      ];
      const fontOptions = [
        { value: 'system', label: t('fontSystem') },
        { value: 'sans', label: t('fontSans') },
        { value: 'serif', label: t('fontSerif') },
        { value: 'mono', label: t('fontMono') },
      ];
      const presetOptions = [
        { value: 'balanced', label: t('aiPresetBalanced') },
        { value: 'concise', label: t('aiPresetConcise') },
        { value: 'professional', label: t('aiPresetProfessional') },
        { value: 'outline', label: t('aiPresetOutline') },
        { value: 'custom', label: t('aiPresetCustom') },
      ];

      const field = (label, hint, control, wide = false) => h(
        'div',
        { className: 'dsh-np-set-field', 'data-wide': wide ? 'true' : 'false' },
        h('span', { className: 'dsh-np-set-label' }, label),
        control,
        hint === '' ? null : h('span', { className: 'dsh-np-set-hint' }, hint),
      );

      const numberInput = ({ onChange, ...rest }) => h(SettingsNumber, { ...rest, onCommit: onChange });

      const card = (title, key, fields, note) => h(
        'section',
        { className: 'dsh-np-set-card', 'data-key': key },
        h('div', { className: 'dsh-np-set-card-head' }, title),
        h('div', { className: 'dsh-np-set-card-body' }, fields),
        note === undefined ? null : h('div', { className: 'dsh-np-set-note' }, note),
      );

      const shortcutRows = [
        ['toggle', 'shortcutToggle'],
        ['reset', 'shortcutReset'],
        ['undo', 'shortcutUndo'],
        ['redo', 'shortcutRedo'],
        ['save', 'shortcutSave'],
      ].map(([action, labelKey]) => h(
        'div',
        { className: 'dsh-np-set-field', key: action },
        h('span', { className: 'dsh-np-set-label' }, t(labelKey)),
        h(SettingsKeyField, {
          value: settings.shortcuts[action],
          ariaLabel: t(labelKey),
          onCommit: (chord) => {
            const duplicate = SHORTCUT_ACTIONS.some((other) =>
              other !== action && settings.shortcuts[other] === chord);
            if (duplicate) {
              announce(t('shortcutHint'));
              return;
            }
            commit({ shortcuts: { ...settings.shortcuts, [action]: chord } });
          },
        }),
      ));

      return h(
        'div',
        {
          className: 'dsh-np-set',
          'data-np-theme': THEME_IDS.includes(settings.theme) ? settings.theme : 'host',
        },
        h(
          'div',
          { className: 'dsh-np-set-head' },
          h('div', { className: 'dsh-np-set-title' }, t('settingsTitle')),
          h('div', { className: 'dsh-np-set-intro' }, t('settingsIntro')),
        ),
        h(
          'div',
          { className: 'dsh-np-set-grid' },
          card(t('appearance'), 'appearance', [
            field(t('theme'), '', h(SettingsDropdown, {
              value: settings.theme,
              options: themeOptions,
              ariaLabel: t('theme'),
              onChange: (value) => commit({ theme: value }),
            })),
            field(t('uiStyle'), '', h(SettingsDropdown, {
              value: settings.uiStyle,
              options: styleOptions,
              ariaLabel: t('uiStyle'),
              onChange: (value) => commit({ uiStyle: value }),
            })),
            field(t('blur'), t('blurHint'), numberInput({
              value: settings.blur,
              min: 0,
              max: 40,
              ariaLabel: t('blur'),
              disabled: settings.uiStyle !== 'glass',
              onChange: (value) => commit({ blur: value }),
            })),
            field(t('font'), '', h(SettingsDropdown, {
              value: settings.font,
              options: fontOptions,
              ariaLabel: t('font'),
              onChange: (value) => commit({ font: value }),
            })),
            field(t('fontSize'), '', numberInput({
              value: settings.fontSize,
              min: 11,
              max: 20,
              ariaLabel: t('fontSize'),
              onChange: (value) => commit({ fontSize: value }),
            })),
            field(t('segmentMaxHeight'), t('segmentMaxHeightHint'), numberInput({
              value: settings.maxSegmentHeight,
              min: 80,
              max: 800,
              ariaLabel: t('segmentMaxHeight'),
              onChange: (value) => commit({ maxSegmentHeight: value }),
            })),
          ]),
          card(t('saveSection'), 'save', [
            field(t('saveMode'), t('autoSaveHint'), h(SettingsToggle, {
              checked: settings.saveMode === 'auto',
              label: settings.saveMode === 'auto' ? t('autoSave') : t('manualSave'),
              onChange: (checked) => commit({ saveMode: checked ? 'auto' : 'manual' }),
            })),
            field(t('undoLimit'), t('undoLimitHint', { n: settings.undoLimit }), numberInput({
              value: settings.undoLimit,
              min: 5,
              max: 200,
              ariaLabel: t('undoLimit'),
              onChange: (value) => commit({ undoLimit: value }),
            })),
          ]),
          card(t('groupsSection'), 'groups', [
            field(t('buttonGroups'), t('buttonGroupsHint'), h(SettingsToggle, {
              checked: settings.buttonGroups,
              onChange: (checked) => commit({ buttonGroups: checked }),
            })),
            settings.buttonGroups
              ? field(t('groupDelay'), t('groupDelayHint'), numberInput({
                  value: settings.groupDelay,
                  min: 0,
                  max: 1000,
                  ariaLabel: t('groupDelay'),
                  onChange: (value) => commit({ groupDelay: value }),
                }))
              : null,
          ].filter(Boolean)),
          card(t('shortcutsSection'), 'shortcuts', [
            ...shortcutRows,
            h(
              'div',
              { className: 'dsh-np-set-actions', key: 'shortcut-reset', 'data-wide': 'true' },
              h('button', {
                type: 'button',
                className: 'dsh-np-set-btn',
                onClick: () => {
                  commit({ shortcuts: { ...SHORTCUT_DEFAULTS } });
                  announce(t('shortcutResetDefaults'));
                },
              }, t('shortcutResetDefaults')),
            ),
          ], t('shortcutHint')),
          card(t('aiSection'), 'ai', [
            field(t('aiPreset'), '', h(SettingsDropdown, {
              value: settings.aiPreset,
              options: presetOptions,
              ariaLabel: t('aiPreset'),
              onChange: (value) => commit({ aiPreset: value }),
            })),
            settings.aiPreset === 'custom'
              ? field(t('aiCustomPrompt'), t('aiCustomHint'), h('textarea', {
                  className: 'dsh-np-set-textarea',
                  value: settings.aiCustom,
                  maxLength: 4000,
                  spellCheck: false,
                  'aria-label': t('aiCustomPrompt'),
                  onChange: (event) => commit({ aiCustom: String(event.target?.value ?? '') }),
                }), true)
              : field(t('aiPresetPrompt'), t('aiPresetHint'), h('textarea', {
                  className: 'dsh-np-set-textarea',
                  value: AI_PRESET_PROMPTS[settings.aiPreset] ?? AI_PRESET_PROMPTS.balanced,
                  readOnly: true,
                  spellCheck: false,
                  'data-readonly': 'true',
                  'aria-label': t('aiPresetPrompt'),
                }), true),
          ], t('aiPromptHint')),
          card(t('windowSection'), 'window', [
            field(t('defaultWidth'), '', numberInput({
              value: settings.defaultWidth,
              min: MIN_W,
              max: 1600,
              ariaLabel: t('defaultWidth'),
              onChange: (value) => commit({ defaultWidth: value }),
            })),
            field(t('defaultHeight'), '', numberInput({
              value: settings.defaultHeight,
              min: MIN_H,
              max: 1200,
              ariaLabel: t('defaultHeight'),
              onChange: (value) => commit({ defaultHeight: value }),
            })),
            h(
              'div',
              { className: 'dsh-np-set-actions', key: 'window-actions', 'data-wide': 'true' },
              h('button', {
                type: 'button',
                className: 'dsh-np-set-btn',
                'data-primary': 'true',
                onClick: () => {
                  const snapshot = requestGeometrySnapshot();
                  const fallback = snapshot === null ? clampUi(readStoredUi()) : snapshot;
                  commit({
                    defaultX: fallback.x,
                    defaultY: fallback.y,
                    defaultWidth: fallback.width,
                    defaultHeight: fallback.height,
                  });
                  announce(t('geometrySaved'));
                },
              }, t('useCurrentGeometry')),
              h('button', {
                type: 'button',
                className: 'dsh-np-set-btn',
                onClick: () => {
                  commit({ defaultWidth: DEFAULT_W, defaultHeight: DEFAULT_H, defaultX: null, defaultY: null });
                  announce(t('resetDefaultSize'));
                },
              }, t('resetDefaultSize')),
              h('button', {
                type: 'button',
                className: 'dsh-np-set-btn',
                onClick: () => {
                  resetWindowGeometry();
                  announce(t('uiReset'));
                },
              }, t('applyResetGeometry')),
            ),
          ], t('geometryHint')),
        ),
        notice === ''
          ? null
          : h('div', { className: 'dsh-np-set-note', role: 'status' }, notice),
      );
    }

    // ------------------------------------------------------------------
    // Settings navigation icon
    // ------------------------------------------------------------------
    const NAV_ICON_NS = 'http://www.w3.org/2000/svg';
    const NAV_VIEW_BOX = '0 0 16 16';
    /** 16-grid line icon of the notepad, matching the host nav stroke style. */
    const NAV_DOM = [
      {
        tag: 'rect',
        attrs: {
          x: '2.2', y: '1.9', width: '11.6', height: '12.2', rx: '2.2',
          fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M5.2 5.8h5.6M5.2 8.2h5.6M5.2 10.6h3.4',
          fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
          'stroke-linecap': 'round', 'data-dsh-notepad-logo': '1',
        },
      },
    ];

    function navSvgNode({ tag, attrs, children }) {
      const node = document.createElementNS(NAV_ICON_NS, tag);
      for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, String(value));
      for (const child of children ?? []) node.appendChild(navSvgNode(child));
      return node;
    }

    function paintNotepadNavIcon(svg) {
      if (svg.querySelector('[data-dsh-notepad-logo]') !== null) return;
      svg.setAttribute('viewBox', NAV_VIEW_BOX);
      svg.replaceChildren(...NAV_DOM.map(navSvgNode));
    }

    /**
     * The host draws a generic gear for every settings section. Replace it on
     * our own row only, identified by the current translated label, with the
     * plugin's notepad line art. If the host class names change, nothing is
     * touched and the original gear remains.
     */
    function wrapSettingsNav(labelOf) {
      const paint = () => {
        try {
          if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
          const label = typeof labelOf === 'function' ? labelOf() : labelOf;
          for (const cell of document.querySelectorAll('[class*="_navCell"]')) {
            const text = (cell.textContent ?? '').trim();
            if (text !== label) continue;
            cell.classList?.add('dsh-notepad-nav');
            const icon = cell.querySelector('[class*="_navIcon"]');
            if (icon !== null && icon !== undefined) paintNotepadNavIcon(icon);
          }
        } catch {
          /* Keep the host gear if the DOM shape changes. */
        }
      };
      paint();
      const Observer = typeof globalThis !== 'undefined' ? globalThis.MutationObserver : undefined;
      if (typeof Observer !== 'function' || typeof document === 'undefined' || document.body === null
        || document.body === undefined) return () => {};
      const observer = new Observer(paint);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return () => observer.disconnect();
    }

    // ------------------------------------------------------------------
    // Plugin body
    // ------------------------------------------------------------------
    function apply(ctx) {
      let translate = fallbackTranslate();

      try {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-notepad', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-notepad: styles');
      } catch (error) {
        console.warn('[dsh-notepad] style injection failed:', error?.message ?? error);
      }

      ctx.effect(() => {
        const locale = ctx.get('locale');
        if (locale === undefined) return undefined;
        let dispose;
        try {
          dispose = locale.register(NS, { zh: DICT.zh, en: DICT.en });
          translate = locale.bind(NS);
        } catch (error) {
          console.warn('[dsh-notepad] locale registration failed:', error?.message ?? error);
          return undefined;
        }
        return () => {
          translate = fallbackTranslate();
          try {
            dispose?.();
          } catch {
            /* Removing a dictionary must never break unload. */
          }
        };
      }, 'dsh-notepad: dictionaries');

      // Settings sidebar icon: the host's generic gear becomes our line icon.
      try {
        ctx.effect(() => wrapSettingsNav(() => translate('settingsTab')), 'dsh-notepad: settings nav icon');
      } catch (error) {
        console.warn('[dsh-notepad] settings nav icon setup failed:', error?.message ?? error);
      }

      // Register every configurable chord with DSH's shortcut service so it
      // reaches the page even when the host intercepts native key bindings.
      // Re-registering after a settings edit keeps the host binding in sync.
      const installShortcuts = (scope) => {
        const service = typeof scope.get === 'function' ? scope.get('shortcuts') : undefined;
        if (service === undefined || service === null || typeof service.register !== 'function') return;
        let disposeCommands = null;
        let boundSignature = '';
        const commands = [
          {
            action: 'toggle',
            id: 'notepad.toggleVisibility',
            labelKey: 'shortcutToggle',
            aliases: ['show notepad', 'hide notepad', 'toggle notepad'],
            regions: ['page', 'editable'],
            run: requestToggleVisibility,
          },
          {
            action: 'reset',
            id: 'notepad.resetGeometry',
            labelKey: 'resetShortcut',
            aliases: ['reset notepad', 'reset notepad geometry'],
            regions: ['page', 'editable'],
            run: requestUiReset,
          },
          {
            action: 'undo',
            id: 'notepad.undo',
            labelKey: 'shortcutUndo',
            aliases: ['undo notepad'],
            regions: ['page'],
            run: () => requestHistory('undo'),
          },
          {
            action: 'redo',
            id: 'notepad.redo',
            labelKey: 'shortcutRedo',
            aliases: ['redo notepad'],
            regions: ['page'],
            run: () => requestHistory('redo'),
          },
          {
            action: 'save',
            id: 'notepad.save',
            labelKey: 'shortcutSave',
            aliases: ['save notepad'],
            regions: ['page', 'editable'],
            run: requestSaveNote,
          },
        ];
        const register = () => {
          const settings = readSettings();
          const signature = SHORTCUT_ACTIONS
            .map((action) => settings.shortcuts[action])
            .join('\u0000');
          if (signature === boundSignature && disposeCommands !== null) return;
          boundSignature = signature;
          if (disposeCommands !== null) {
            disposeCommands();
            disposeCommands = null;
          }
          hostHandledShortcuts.clear();
          const disposers = [];
          for (const command of commands) {
            const parsed = parseShortcut(settings.shortcuts[command.action]);
            if (parsed === null) continue;
            const chord = { code: parsed.code, modifiers: [...parsed.modifiers] };
            try {
              const dispose = service.register({
                id: command.id,
                label: () => translate(command.labelKey),
                aliases: command.aliases,
                defaults: {
                  'desktop:macos': { ...chord, modifiers: [...chord.modifiers] },
                  'desktop:windows': { ...chord, modifiers: [...chord.modifiers] },
                  'desktop:linux': { ...chord, modifiers: [...chord.modifiers] },
                  'web:macos': { ...chord, modifiers: [...chord.modifiers] },
                  'web:windows': { ...chord, modifiers: [...chord.modifiers] },
                  'web:linux': { ...chord, modifiers: [...chord.modifiers] },
                },
                regions: command.regions,
                modals: [],
                resolve: () => ({
                  status: 'handled',
                  run: () => {
                    if (!shortcutRecording) command.run();
                  },
                }),
              });
              if (typeof dispose === 'function') disposers.push(dispose);
              hostHandledShortcuts.add(command.action);
            } catch (error) {
              console.warn(`[dsh-notepad] ${command.id} registration failed:`, error?.message ?? error);
            }
          }
          disposeCommands = () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                /* unload must not throw */
              }
            }
            hostHandledShortcuts.clear();
          };
        };
        register();
        const unsubscribe = subscribeSettings(register);
        const cleanup = () => {
          unsubscribe();
          if (disposeCommands !== null) disposeCommands();
          disposeCommands = null;
          boundSignature = '';
        };
        if (typeof scope.effect === 'function') {
          scope.effect(() => cleanup, 'dsh-notepad: shortcut commands');
        }
      };
      if (ctx.get('shortcuts') !== undefined) {
        installShortcuts(ctx);
      } else if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['shortcuts'], (scoped) => installShortcuts(scoped));
        } catch {
          /* The raw key listener and header buttons remain as fallbacks. */
        }
      }

      // Archive chat sends even before the overlay's first mount; the overlay
      // itself still owns the listener and reuses this hook.
      try {
        installComposerSendPatch(ctx);
      } catch {
        /* The overlay retries when it mounts. */
      }

      const slots = ctx.get('slots');
      if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        console.warn('[dsh-notepad] slots service missing; floating notepad disabled');
        return;
      }

      try {
        ctx.effect(
          () => slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: 'notepad', order: 70 },
            () => h(NotepadOverlay, { ctx, t: (key, params) => translate(key, params) }),
          )),
          'dsh-notepad: overlay',
        );
      } catch (error) {
        console.warn('[dsh-notepad] could not register shell.overlay:', error?.message ?? error);
      }

      // Settings tab: style, saving, history, buttons, shortcuts, AI and window.
      try {
        ctx.effect(
          () => slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'notepad', order: 26, label: () => translate('settingsTab') },
            () => h(NotepadSettings, { t: (key, params) => translate(key, params) }),
          )),
          'dsh-notepad: settings tab',
        );
      } catch (error) {
        console.warn('[dsh-notepad] could not register settings.section:', error?.message ?? error);
      }
    }

    return {
      inject: ['slots'],
      apply,
      // exported for the render smoke test only (the host never reads it)
      __test: {
        NAV_DOM,
        NAV_VIEW_BOX,
        paintNotepadNavIcon,
        wrapSettingsNav,
        parseShortcut,
        resolveWorkspaceId,
      },
    };
  },
});
}
})();
