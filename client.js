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
    const SIDEBAR_REFRESH_MS = 20000;
    const IMAGE_DELETE_DELAY = 5000;
    const OPTIMIZE_CACHE_LIMIT = 100;
    const EDGE_GAP = 8;
    const IMAGE_MIME = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };

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
        selectHint: '勾选分段可批量操作',
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
        show: '显示记事本（Ctrl+Shift+N）',
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
        selectHint: 'Check segments to batch',
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
        show: 'Show notepad (Ctrl+Shift+N)',
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
      },
    };

    /** Rotating shortcut tips shown one at a time in the footer. */
    const HINT_KEYS = [
      'hintEnter',
      'hintNewline',
      'hintInsert',
      'hintToggle',
      'hintReset',
      'hintArrow',
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
    const FONT_STACK = 'var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif)';
    const CSS = `.dsh-np-card{--np-accent:var(--dsw-alias-state-business-primary,#4176e6);--np-accent-fg:#fff;--np-surface:var(--dsw-alias-bg-layer-1,#fff);--np-surface-2:var(--dsw-alias-bg-layer-2,#fff);position:fixed;z-index:30;display:flex;flex-direction:column;box-sizing:border-box;width:${DEFAULT_W}px;max-width:calc(100vw - 16px);height:${DEFAULT_H}px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:14px;background:var(--np-surface);color:var(--dsw-alias-label-primary,#1f2430);box-shadow:var(--dsw-elevation-prominent,0 20px 50px rgb(15 23 42/.22),0 2px 8px rgb(15 23 42/.08));overflow:hidden;backdrop-filter:saturate(1.2) blur(10px);font-family:${FONT_STACK};font-size:13px;line-height:1.5;transition:height .2s ease,opacity .18s ease,transform .18s ease}
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
.dsh-np-workspace{min-width:0;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10.5px;line-height:16px;flex:0 1 auto}
.dsh-np-spacer{flex:1 1 auto;min-width:0}
.dsh-np-btn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background .12s,color .12s,opacity .12s}
.dsh-np-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-btn[data-active=true]{background:color-mix(in srgb,var(--np-accent) 12%,transparent);color:var(--np-accent)}
.dsh-np-btn[data-accent=true]{background:var(--np-accent);color:var(--np-accent-fg)}
.dsh-np-btn[data-accent=true]:hover:not(:disabled){background:color-mix(in srgb,var(--np-accent) 88%,#000);color:var(--np-accent-fg)}
.dsh-np-btn:disabled{opacity:.38;cursor:default;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-np-btn:focus-visible,.dsh-np-segbtn:focus-visible,.dsh-np-link:focus-visible,.dsh-np-empty-add:focus-visible,.dsh-np-toast-action:focus-visible,.dsh-np-selectall input:focus-visible,.dsh-np-check input:focus-visible,.dsh-np-title-add:focus-visible,.dsh-np-preview-btn:focus-visible,.dsh-np-confirm-btn:focus-visible,button.dsh-np-hint:focus-visible,.dsh-np-restore:focus-visible,.dsh-np-img-open:focus-visible,.dsh-np-img-remove:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.dsh-np-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:8px 10px 0;opacity:1;transition:opacity .16s ease,visibility 0s linear 0s}
.dsh-np-card[data-minimized=true] .dsh-np-body{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,visibility 0s linear .16s}
.dsh-np-tools{display:flex;align-items:center;flex-wrap:wrap;gap:4px;flex:none;padding:0 2px 7px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08))}
.dsh-np-selectall{display:inline-flex;align-items:center;gap:6px;min-width:0;cursor:pointer;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;white-space:nowrap}
.dsh-np-selectall input{width:14px;height:14px;margin:0;accent-color:var(--np-accent);cursor:pointer;flex:none}
.dsh-np-selectall input:disabled{cursor:default;opacity:.45}
.dsh-np-selcount{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.dsh-np-list{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;padding:8px 2px 8px 0;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-np-seg{display:flex;flex-direction:column;flex:none;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:10px;background:var(--np-surface-2);transition:border-color .12s,background .12s,opacity .12s;animation:dsh-np-item-in .16s ease-out}
.dsh-np-seg[data-selected=true]{border-color:var(--np-accent);background:color-mix(in srgb,var(--np-accent) 6%,var(--np-surface-2));box-shadow:0 0 0 1px var(--np-accent) inset}
.dsh-np-seg[data-archived=true]{border-style:dashed;background:transparent;opacity:.82;animation:none}
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
.dsh-np-actiongroup{display:inline-flex;align-items:center;flex:none;padding:1px;border:1px solid transparent;border-radius:8px;transition:border-color .12s ease .12s,background .12s ease .12s}
.dsh-np-actiongroup:hover{border-color:var(--dsw-alias-border-l2,rgb(15 23 42/.14));background:color-mix(in srgb,var(--np-surface-2) 58%,transparent);transition-delay:.18s}
.dsh-np-actiongroup:focus-within{border-color:var(--dsw-alias-border-l2,rgb(15 23 42/.14));background:color-mix(in srgb,var(--np-surface-2) 58%,transparent);transition-delay:0s}
.dsh-np-group-extra{width:0!important;min-width:0;padding:0;border:0;opacity:0;visibility:hidden;pointer-events:none;overflow:hidden;transition:width .14s ease .12s,opacity .12s ease .12s,visibility 0s linear .26s}
.dsh-np-actiongroup:hover .dsh-np-group-extra{width:24px!important;opacity:1;visibility:visible;pointer-events:auto;transition:width .14s ease .2s,opacity .12s ease .2s,visibility 0s linear .2s}
.dsh-np-actiongroup:focus-within .dsh-np-group-extra{width:24px!important;opacity:1;visibility:visible;pointer-events:auto;transition-delay:0s}
.dsh-np-actiongroup[data-size=bar]:hover .dsh-np-group-extra,.dsh-np-actiongroup[data-size=bar]:focus-within .dsh-np-group-extra{width:27px!important}
.dsh-np-seg-text{display:block;width:100%;box-sizing:border-box;padding:2px 10px 8px;border:0;outline:0;resize:none;background:transparent;color:inherit;font-family:${FONT_STACK};font-size:13px;line-height:1.6;min-height:26px;max-height:240px;overflow-y:hidden;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.dsh-np-seg-text::placeholder{color:var(--dsw-alias-label-caption,#9aa3b2)}
.dsh-np-seg-text:disabled{opacity:.6}
.dsh-np-file{display:none}
.dsh-np-editor{display:flex;flex-direction:column;min-width:0;border-radius:0 0 9px 9px;transition:background .12s}
.dsh-np-editor[data-drag=true]{background:color-mix(in srgb,var(--np-accent) 8%,transparent);box-shadow:inset 0 0 0 1.5px var(--np-accent)}
.dsh-np-medias{display:flex;flex-wrap:wrap;gap:5px;padding:5px 9px 0}
.dsh-np-img{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:38px;padding:2px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:8px;background:var(--np-surface);box-shadow:0 1px 2px rgb(15 23 42/.05)}
.dsh-np-img[data-pending=true]{padding-right:8px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-np-img-open{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));overflow:hidden;cursor:zoom-in}
.dsh-np-img-open img{display:block;width:100%;height:100%;object-fit:cover}
.dsh-np-img-name{max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:13px;color:var(--dsw-alias-label-secondary,#4b5563)}
.dsh-np-img-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;width:17px;height:17px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-caption,#9aa3b2);cursor:pointer}
.dsh-np-img-remove:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-state-error-primary,#e25555)}
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

    function autoGrow(element) {
      if (element === null || element === undefined || element.style === undefined) return;
      try {
        element.style.height = 'auto';
        const height = Number(element.scrollHeight);
        if (Number.isFinite(height) && height > 0) {
          const capped = height > MAX_SEGMENT_HEIGHT;
          element.style.height = `${Math.min(MAX_SEGMENT_HEIGHT, Math.max(26, height))}px`;
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
      const base = {
        x: null,
        y: null,
        width: DEFAULT_W,
        height: DEFAULT_H,
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
          x: Number.isFinite(parsed.x) ? parsed.x : null,
          y: Number.isFinite(parsed.y) ? parsed.y : null,
          width: Number.isFinite(parsed.width) ? parsed.width : DEFAULT_W,
          height: Number.isFinite(parsed.height) ? parsed.height : DEFAULT_H,
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

    async function optimizeNoteText(root, sessionId, text, title) {
      const response = await fetch(`${API}/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, sessionId, text, title }),
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

    /** Whether the host shortcut service already owns Ctrl/Cmd+Shift+0. */
    let resetShortcutHandledByHost = false;

    /** Ask every mounted notepad to reset its position and size. */
    function requestUiReset() {
      let handled = false;
      for (const handler of resetHandlers) {
        try {
          handler();
          handled = true;
        } catch {
          /* One failing overlay must not block the others. */
        }
      }
      return handled;
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

      const setSelection = (next) => {
        selectedRef.current = next;
        setSelected(next);
      };

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

      // Session + workspace -------------------------------------------------
      useEffect(() => {
        let disposed = false;
        const uiSession = ctx.get('uiSession');
        const sessions = ctx.get('sessions');
        const current = uiSession?.adapter?.current;
        if (current === undefined || sessions === undefined) {
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

      const resetGeometry = () => {
        setUi((previous) => clampUi({
          ...previous,
          x: null,
          y: null,
          width: DEFAULT_W,
          height: DEFAULT_H,
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
        invalidateBatchUndo();
        segmentsRef.current = next;
        setSegments(next);
        pruneSelectionFor(next);
        if (options.focus !== undefined) pendingFocusRef.current = options.focus;
        dirtyRef.current = true;
        setStatus('dirty');
        setError('');
        scheduleSave();
      };

      // Load on workspace/session change ------------------------------------
      useEffect(() => {
        if (binding === null) {
          rootRef.current = '';
          rootSessionRef.current = '';
          segmentsRef.current = [];
          setSegments([]);
          setSelection(new Set());
          setSegmentUndo(new Map());
          setBatchUndoState(null);
          setTitleEditing('');
          setPreviewImage(null);
          setDeleteConfirm('');
          pendingScrollRef.current = null;
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
        rootRef.current = root;
        rootSessionRef.current = binding.id;
        let cancelled = false;
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
        setStatus('loading');
        setError('');
        const load = () => {
          const mySeq = ++loadSeqRef.current;
          loadFailedRef.current = false;
          setStatus('loading');
          setError('');
          fetchNote(root, binding.id)
            .then((data) => {
              if (cancelled || rootRef.current !== root || mySeq !== loadSeqRef.current) return;
              let value = readServerSegments(data);
              if (value.length === 0) value = [newSegment('')];
              segmentsRef.current = value;
              setSegments(value);
              setSelection(new Set());
              setSegmentUndo(new Map());
              setBatchUndoState(null);
              versionRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
              setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : null);
              dirtyRef.current = false;
              setStatus('saved');
            })
            .catch((reason) => {
              if (cancelled || rootRef.current !== root || mySeq !== loadSeqRef.current) return;
              loadFailedRef.current = true;
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
          return undefined;
        }
        setCurrentWsId('');
        let disposed = false;
        const refresh = () => {
          const sessionId = binding.id;
          if (typeof sessionId !== 'string' || sessionId === '') return;
          fetchUnsentCounts(sessionId)
            .then((data) => {
              if (disposed || bindingRef.current?.id !== sessionId) return;
              const next = {};
              let matched = '';
              const target = normalizedCwd(binding.cwd);
              for (const workspace of Array.isArray(data?.workspaces) ? data.workspaces : []) {
                const id = typeof workspace?.id === 'string' ? workspace.id : '';
                if (id === '') continue;
                next[id] = Number.isFinite(workspace.count) ? Math.max(0, Math.floor(workspace.count)) : 0;
                if (matched === '' && normalizedCwd(workspace.path) === target) matched = id;
              }
              setWsCounts(next);
              if (matched !== '') setCurrentWsId(matched);
            })
            .catch(() => {});
        };
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
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [binding === null ? '' : binding.id, binding === null ? '' : binding.cwd]);

      const localUnsentCount = countUnsent(segments);

      useEffect(() => {
        if (currentWsId === '') return;
        setWsCounts((previous) =>
          (previous[currentWsId] === localUnsentCount
            ? previous
            : { ...previous, [currentWsId]: localUnsentCount }));
      }, [currentWsId, localUnsentCount]);

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
            const count = id === '' ? 0 : (wsCounts[id] ?? 0);
            if (count > 0) row.setAttribute('data-np-unsent', count > 99 ? '99+' : String(count));
            else row.removeAttribute('data-np-unsent');
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
      }, [wsCounts]);

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
        autoGrow(element);
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
          const chord = event.ctrlKey || event.metaKey;
          if (!chord || !event.shiftKey || event.altKey) return;
          if (event.key === 'N' || event.key === 'n') {
            event.preventDefault();
            setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
            return;
          }
          if (!resetShortcutHandledByHost
            && (event.key === 'R' || event.key === 'r' || event.code === 'KeyR')) {
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

      // Close the preview / delete confirmation with Escape ----------------
      useEffect(() => {
        if (previewImage === null && deleteConfirm === '') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setPreviewImage(null);
          setDeleteConfirm('');
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [previewImage, deleteConfirm]);

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
              setSegments(value);
              pruneSelectionFor(value);
              setSegmentUndo(new Map());
              setBatchUndoState(null);
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

      const archiveSegment = (id) => {
        const current = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
        if (current === undefined) return;
        const archivedAt = new Date().toISOString();
        const next = segmentsRef.current.map((segment) =>
          (segment.id === id ? { ...segment, archived: true, archivedAt } : segment));
        setSelection(new Set([...selectedRef.current].filter((value) => value !== id)));
        commitSegments(next);
        showToast(t('archivedToast'));
      };

      const archiveSelected = () => {
        const ids = new Set(
          segmentsRef.current
            .filter((segment) => segment.archived !== true && selectedRef.current.has(segment.id))
            .map((segment) => segment.id),
        );
        if (ids.size === 0) return;
        const archivedAt = new Date().toISOString();
        const next = segmentsRef.current.map((segment) =>
          (ids.has(segment.id) ? { ...segment, archived: true, archivedAt } : segment));
        setSelection(new Set());
        commitSegments(next);
        showToast(t('archivedCount', { n: ids.size }));
      };

      const restoreSegment = (id) => {
        const current = segmentsRef.current.find((segment) => segment.id === id && segment.archived === true);
        if (current === undefined) return;
        const next = segmentsRef.current.map((segment) =>
          (segment.id === id ? { ...segment, archived: false, archivedAt: null } : segment));
        commitSegments(next, { focus: { id, caret: current.text.length } });
        showToast(t('restoredToast'));
      };

      const restoreAll = () => {
        const restored = segmentsRef.current.filter((segment) => segment.archived === true);
        if (restored.length === 0) return;
        const next = segmentsRef.current.map((segment) =>
          (segment.archived === true ? { ...segment, archived: false, archivedAt: null } : segment));
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
        undoRef.current = { snapshot: segmentsRef.current };
        const next = segmentsRef.current.filter((segment) => segment.id !== id);
        commitSegments(next);
        scheduleImageCleanup(target.images);
        showToast(t('deletedToast'), { label: t('undo'), onClick: undoLast });
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
        const next = segmentsRef.current.filter((segment) => segment.id !== id);
        commitSegments(next);
        scheduleImageCleanup(target.images);
        showToast(t('deletedToast'));
      };

      const clearArchive = () => {
        const archived = segmentsRef.current.filter((segment) => segment.archived === true);
        if (archived.length === 0) return;
        undoRef.current = { snapshot: segmentsRef.current };
        const next = segmentsRef.current.filter((segment) => segment.archived !== true);
        commitSegments(next);
        scheduleImageCleanup(archived.flatMap((segment) => (Array.isArray(segment.images) ? segment.images : [])));
        showToast(t('clearedArchive', { n: archived.length }), { label: t('undo'), onClick: undoLast });
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

      /** Cache key: the prompt depends on the workspace, title and card text. */
      const optimizationCacheKey = (root, segment) =>
        `${root}\u0000${segment.title ?? ''}\u0000${segment.text}`;

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

      const requestOptimization = async (segment) => {
        const root = rootRef.current;
        const sessionId = rootSessionRef.current;
        if (root === '' || sessionId === '') throw new Error(t('optimizeUnavailable'));
        if (segment.text.length > MAX_OPTIMIZE_CHARS) throw new Error(t('optimizeTooLong'));
        const cacheKey = optimizationCacheKey(root, segment);
        const cached = optimizeCacheRef.current.get(cacheKey);
        if (typeof cached === 'string' && cached !== '') return cached;
        const data = await optimizeNoteText(root, sessionId, segment.text, segment.title ?? '');
        const value = typeof data.text === 'string' ? data.text.trim() : '';
        if (value === '') throw new Error(t('optimizeFailed'));
        rememberOptimization(cacheKey, value);
        return value;
      };

      const optimizeSegment = async (id) => {
        if (optimizingRef.current.has(id)) return;
        const target = segmentsRef.current.find((segment) => segment.id === id && segment.archived !== true);
        if (target === undefined || target.text.trim() === '') {
          showToast(t('optimizeEmpty'));
          return;
        }
        const original = target.text;
        markOptimizing(id, true);
        try {
          const value = await requestOptimization(target);
          const current = segmentsRef.current.find((segment) => segment.id === id);
          if (current === undefined || current.text !== original || value === original) return;
          const next = segmentsRef.current.map((segment) =>
            (segment.id === id ? { ...segment, text: value } : segment));
          commitSegments(next);
          setSegmentUndo((previous) => {
            const updated = new Map(previous);
            updated.set(id, { before: original, after: value });
            return updated;
          });
          showToast(t('optimizedToast'));
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
          const next = segmentsRef.current.map((segment) =>
            (segment.id === id ? { ...segment, text: record.before } : segment));
          commitSegments(next);
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
        let done = 0;
        let changed = 0;
        let failed = 0;
        setOptimizeBatch({ done, total: targets.length });
        try {
          for (const target of targets) {
            const current = segmentsRef.current.find((segment) =>
              segment.id === target.id && segment.archived !== true);
            if (current !== undefined && current.text === target.text) {
              markOptimizing(target.id, true);
              try {
                const value = await requestOptimization(current);
                if (value !== current.text) {
                  const next = segmentsRef.current.map((segment) =>
                    (segment.id === target.id && segment.text === current.text
                      ? { ...segment, text: value }
                      : segment));
                  commitSegments(next);
                  setSegmentUndo((previous) => {
                    const updated = new Map(previous);
                    updated.set(target.id, { before: current.text, after: value });
                    return updated;
                  });
                  changed += 1;
                }
              } catch {
                failed += 1;
              } finally {
                markOptimizing(target.id, false);
              }
            }
            done += 1;
            setOptimizeBatch({ done, total: targets.length });
          }
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

      // Composer actions ----------------------------------------------------
      const insertValue = (value) => {
        const actions = inputActionsRef.current;
        if (actions === null || actions === undefined) return false;
        if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false;
        try {
          const span = actions.captureInsertion();
          if (actions.insertText(value, span) === true) {
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
        try {
          actions.setDraft(value);
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
              (ids.has(segment.id) ? { ...segment, archived: true, archivedAt } : segment));
            setSelection(new Set([...selectedRef.current].filter((id) => !ids.has(id))));
            commitSegments(next);
          }
        } catch (reason) {
          showToast(`${t('sendFailed')}: ${String(reason?.message ?? reason)}`);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      /** Create an empty session in a workspace and return its id. */
      const createWorkspaceSession = async (cwd) => {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null || typeof sessions.create !== 'function') return null;
        const result = await sessions.create({ cwd });
        if (result === undefined || result === null) return null;
        if (result.ok === false) {
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
        try {
          const newSessionId = await createWorkspaceSession(cwd);
          if (newSessionId === null) {
            if (!insertValue(value)) await copyText(value);
            showToast(t('sendNewUnavailable'));
            return;
          }
          const accepted = await sendToSession(value, newSessionId);
          if (accepted !== true) {
            if (!insertValue(value)) await copyText(value);
            showToast(t('sendUnavailable'));
            return;
          }
          showToast(t('sendNewDone'));
          const ids = new Set(
            list.filter((segment) => segment.archived !== true).map((segment) => segment.id),
          );
          if (ids.size > 0 && (rootRef.current === '' || rootRef.current === cwd)) {
            const archivedAt = new Date().toISOString();
            const next = segmentsRef.current.map((segment) =>
              (ids.has(segment.id) ? { ...segment, archived: true, archivedAt } : segment));
            setSelection(new Set([...selectedRef.current].filter((id) => !ids.has(id))));
            commitSegments(next);
            await saveNowRef.current?.({ force: true });
          }
          const uiWorkspace = ctx.get('uiWorkspace');
          if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function') {
            uiWorkspace.openSession(newSessionId);
          }
        } catch (reason) {
          showToast(`${t('sendFailed')}: ${String(reason?.message ?? reason)}`);
        } finally {
          sendingRef.current = false;
          setSending(false);
        }
      };

      const copyAll = async () => {
        // Copy only active work: archived segments were already sent or filed
        // away and must not leak back into a copy-all.
        const value = mergedText(segmentsRef.current.filter((segment) => segment.archived !== true));
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        showToast((await copyText(value)) ? t('copied') : t('copyFailed'));
      };

      // UI actions ----------------------------------------------------------
      const toggleCollapse = () => {
        setUi((previous) => clampUi({ ...previous, minimized: !previous.minimized }));
      };

      const toggleHidden = () => {
        setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
      };

      const toggleArchive = () => {
        const open = ui.showArchive !== true;
        setUi((previous) => ({ ...previous, showArchive: open }));
        if (open) {
          setTimeout(() => {
            const list = listRef.current;
            if (list !== null && list !== undefined) list.scrollTop = list.scrollHeight;
          }, 260);
        }
      };

      const onSegmentChange = (event, id) => {
        const target = event.currentTarget ?? event.target;
        autoGrow(target);
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
        const remaining = segmentsRef.current.filter((segment) => segment.id !== id);
        const activeRemaining = remaining.filter((segment) => segment.archived !== true);
        if (activeRemaining.length === 0) {
          const fresh = newSegment('');
          commitSegments([fresh], { focus: { id: fresh.id, caret: 0 } });
          return;
        }
        const focus = previous ?? next;
        if (focus === undefined) {
          commitSegments(remaining);
          return;
        }
        const caret = previous !== undefined ? previous.text.length : 0;
        commitSegments(remaining, { focus: { id: focus.id, caret } });
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
          const firstBreak = value.indexOf('\n');
          const lastBreak = value.lastIndexOf('\n');
          const up = event.key === 'ArrowUp';
          const atEdge = up
            ? (firstBreak === -1 || start <= firstBreak)
            : (lastBreak === -1 || start > lastBreak);
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

      // Render --------------------------------------------------------------
      if (binding === null || present !== true) return null;

      const activeSegments = segments.filter((segment) => segment.archived !== true);
      const archivedSegments = segments.filter((segment) => segment.archived === true);
      const selectedActive = activeSegments.filter((segment) => selected.has(segment.id));
      const selectedCount = selectedActive.length;
      const allSelected = activeSegments.length > 0 && selectedCount === activeSegments.length;
      const unsentCount = countUnsent(segments);
      const totalChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
      const activeChars = activeSegments.reduce((sum, segment) => sum + segment.text.length, 0);
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

      const header = h(
        'div',
        { className: 'dsh-np-head', onPointerDown: onHeaderPointerDown },
        h('span', { className: 'dsh-np-dot', 'data-state': status }),
        h('span', { className: 'dsh-np-title' }, t('title')),
        h('span', { className: 'dsh-np-workspace', title: binding.cwd }, workspaceName(binding.cwd)),
        h('span', { className: 'dsh-np-spacer' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: `${t('resetShortcut')} · Ctrl+Shift+R`,
            'aria-label': t('resetShortcut'),
            onClick: resetGeometry,
          },
          h(ResetIcon, { size: 15 }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: t('copy'),
            'aria-label': t('copy'),
            disabled: activeChars === 0,
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
          onClick: primary.onClick,
        };
        if (primary.accent === true) primaryProps['data-accent'] = 'true';
        const extraProps = {
          type: 'button',
          className: `${base} dsh-np-group-extra`,
          title: extra.title,
          'aria-label': extra.title,
          disabled,
          onClick: extra.onClick,
        };
        if (extra.danger === true) extraProps['data-danger'] = 'true';
        return h(
          'div',
          { className: 'dsh-np-actiongroup', 'data-size': size },
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
        h('span', { className: 'dsh-np-spacer' }),
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
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: selectedCount > 0 ? t('archiveSelected', { n: selectedCount }) : t('archive'),
            'aria-label': t('archive'),
            disabled: selectedCount === 0,
            onClick: archiveSelected,
          },
          h(ArchiveIcon, { size: 14 }),
        ),
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
            h('span', { className: 'dsh-np-img-name', title: image.path }, image.name),
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

      const activeCards = activeSegments.map((segment, index) => {
        const images = Array.isArray(segment.images) ? segment.images : [];
        const empty = segment.text.trim() === '' && images.length === 0;
        const titleValue = segment.title ?? '';
        const showTitleInput = titleValue !== '' || titleEditing === segment.id;
        const undoRecord = segmentUndo.get(segment.id);
        const canUndoOptimize = undoRecord !== undefined && undoRecord.after === segment.text;
        const optimizingNow = optimizing.has(segment.id);
        const aiBusy = optimizingNow || optimizeBatch !== null;
        const aiTitle = aiBusy
          ? t('optimizing')
          : canUndoOptimize ? t('undoOptimize') : t('optimizeSegment');
        return h(
          'article',
          {
            key: segment.id,
            className: 'dsh-np-seg',
            'data-seg-id': segment.id,
            'data-archived': 'false',
            'data-selected': selected.has(segment.id) ? 'true' : 'false',
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
            ref: (element) => {
              if (element === null || element === undefined) {
                fileInputRefs.current.delete(segment.id);
                return;
              }
              fileInputRefs.current.set(segment.id, element);
            },
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
              'label',
              { className: 'dsh-np-check', title: t('selectSegment') },
              h('input', {
                type: 'checkbox',
                checked: selected.has(segment.id),
                'aria-label': t('selectSegment'),
                onChange: () => toggleSelected(segment.id),
              }),
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
                    if (dirtyRef.current) saveNowRef.current?.();
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
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                'data-ai': 'true',
                title: aiTitle,
                'aria-label': aiTitle,
                disabled: aiBusy || (canUndoOptimize ? false : empty),
                onClick: canUndoOptimize
                  ? () => undoOptimizeSegment(segment.id)
                  : () => optimizeSegment(segment.id),
              },
              optimizingNow
                ? h('span', { className: 'dsh-np-mini-spinner' })
                : canUndoOptimize ? h(UndoIcon, { size: 14 }) : h(SparkleIcon, { size: 14 }),
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
          h(
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
              ref: (element) => {
                if (element === null || element === undefined) {
                  textareaRefs.current.delete(segment.id);
                  return;
                }
                textareaRefs.current.set(segment.id, element);
                autoGrow(element);
              },
              className: 'dsh-np-seg-text',
              rows: 1,
              value: segment.text,
              placeholder: index === activeSegments.length - 1 ? t('placeholder') : t('segmentPlaceholder'),
              spellCheck: false,
              maxLength: MAX_SEGMENT_CHARS,
              'aria-label': t('editor'),
              onChange: (event) => onSegmentChange(event, segment.id),
              onKeyDown: (event) => onSegmentKeyDown(event, segment.id),
              onBlur: () => {
                if (dirtyRef.current) saveNowRef.current?.();
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
                    { className: 'dsh-np-archive-list' },
                    archivedSegments.map((segment) => h(
                      'article',
                      {
                        key: segment.id,
                        className: 'dsh-np-seg',
                        'data-seg-id': segment.id,
                        'data-archived': 'true',
                      },
                      h(
                        'div',
                        { className: 'dsh-np-seg-head' },
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
                            title: t('insertSegment'),
                            'aria-label': t('insertSegment'),
                            disabled: segment.text.trim() === ''
                              && !(Array.isArray(segment.images) && segment.images.length > 0),
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
                              && !(Array.isArray(segment.images) && segment.images.length > 0),
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
                      h('div', { className: 'dsh-np-seg-archived-text' },
                        segment.text === ''
                          ? (Array.isArray(segment.images) && segment.images.length > 0 ? null : t('emptySegment'))
                          : segment.text),
                      renderMedia(segment, { readOnly: true }),
                    )),
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

      const deleteTarget = deleteConfirm === ''
        ? undefined
        : segments.find((segment) => segment.id === deleteConfirm && segment.archived !== true);
      const confirmNode = deleteTarget === undefined
        ? null
        : h(
            'div',
            {
              className: 'dsh-np-confirm',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-label': t('deleteConfirmTitle'),
              onClick: () => setDeleteConfirm(''),
            },
            h(
              'div',
              {
                className: 'dsh-np-confirm-card',
                onClick: (event) => event?.stopPropagation?.(),
              },
              h('div', { className: 'dsh-np-confirm-title' }, t('deleteConfirmTitle')),
              h('div', { className: 'dsh-np-confirm-body' }, t('deleteConfirmBody')),
              h('div', { className: 'dsh-np-confirm-hint' }, t('deleteConfirmHint')),
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
                    onClick: () => deleteActiveSegment(deleteTarget.id),
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
          'aria-hidden': ui.hidden ? 'true' : undefined,
          style: {
            left: `${left}px`,
            top: `${top}px`,
            width: `${displayWidth}px`,
            height: `${displayHeight}px`,
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
          title: t('show'),
          'aria-label': t('show'),
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

      // Register the geometry-reset chord with DSH's shortcut service so it
      // reaches the page even when the host intercepts native key bindings.
      const installResetShortcut = (scope) => {
        const service = typeof scope.get === 'function' ? scope.get('shortcuts') : undefined;
        if (service === undefined || service === null || typeof service.register !== 'function') return;
        try {
          scope.effect(() => service.register({
            id: 'notepad.resetGeometry',
            label: () => translate('resetShortcut'),
            aliases: ['reset notepad', 'reset notepad geometry'],
            defaults: {
              'desktop:macos': { code: 'KeyR', modifiers: ['primary', 'shift'] },
              'desktop:windows': { code: 'KeyR', modifiers: ['primary', 'shift'] },
              'desktop:linux': { code: 'KeyR', modifiers: ['primary', 'shift'] },
              'web:macos': { code: 'KeyR', modifiers: ['primary', 'shift'] },
              'web:windows': { code: 'KeyR', modifiers: ['primary', 'shift'] },
              'web:linux': { code: 'KeyR', modifiers: ['primary', 'shift'] },
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => ({ status: 'handled', run: requestUiReset }),
          }), 'dsh-notepad: reset shortcut');
          resetShortcutHandledByHost = true;
        } catch (error) {
          console.warn('[dsh-notepad] reset shortcut registration failed:', error?.message ?? error);
        }
      };
      if (ctx.get('shortcuts') !== undefined) {
        installResetShortcut(ctx);
      } else if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['shortcuts'], (scoped) => installResetShortcut(scoped));
        } catch {
          /* The raw key listener and header button remain as fallbacks. */
        }
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
    }

    return {
      inject: ['slots'],
      apply,
    };
  },
});
}
})();
