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
    const { useState, useEffect, useRef } = React;

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
    const MAX_IMAGES = 20;
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
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
        archive: '归档',
        archiveSegment: '归档此段',
        archiveSelected: '归档选中的 {n} 段',
        archived: '归档',
        archivedToast: '已归档，可在归档中查看',
        archivedCount: '已归档 {n} 段',
        showArchive: '显示归档（{n}）',
        hideArchive: '隐藏归档（{n}）',
        archiveCount: '归档 · {n}',
        archiveEmpty: '还没有归档的分段',
        noActive: '没有进行中的分段',
        restore: '恢复',
        restoreSegment: '恢复此段',
        restoreAll: '全部恢复',
        restoredToast: '已恢复',
        restoredCount: '已恢复 {n} 段',
        deleteSegment: '删除此段',
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
        hint: 'Enter 新建分段 · Shift+Enter 换行 · Ctrl+Enter 插入 · 支持粘贴图片',
        workspace: '工作区',
        resize: '拖动调整大小',
        addImage: '添加图片',
        removeImage: '移除图片',
        openImage: '打开图片',
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
        archive: 'Archive',
        archiveSegment: 'Archive this segment',
        archiveSelected: 'Archive {n} selected',
        archived: 'Archived',
        archivedToast: 'Archived; available under Archive',
        archivedCount: 'Archived {n}',
        showArchive: 'Show archive ({n})',
        hideArchive: 'Hide archive ({n})',
        archiveCount: 'Archive · {n}',
        archiveEmpty: 'Nothing archived yet',
        noActive: 'No active segments',
        restore: 'Restore',
        restoreSegment: 'Restore this segment',
        restoreAll: 'Restore all',
        restoredToast: 'Restored',
        restoredCount: 'Restored {n}',
        deleteSegment: 'Delete this segment',
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
        hint: 'Enter new segment · Shift+Enter newline · Ctrl+Enter insert · Paste images',
        workspace: 'Workspace',
        resize: 'Drag to resize',
        addImage: 'Add image',
        removeImage: 'Remove image',
        openImage: 'Open image',
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
.dsh-np-btn:focus-visible,.dsh-np-segbtn:focus-visible,.dsh-np-link:focus-visible,.dsh-np-empty-add:focus-visible,.dsh-np-toast-action:focus-visible,.dsh-np-selectall input:focus-visible,.dsh-np-check input:focus-visible,.dsh-np-restore:focus-visible,.dsh-np-img-open:focus-visible,.dsh-np-img-remove:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.dsh-np-badge{position:absolute;top:2px;right:2px;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--np-accent);color:var(--np-accent-fg);font-size:9px;font-weight:600;line-height:13px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-np-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:8px 10px 0;opacity:1;transition:opacity .16s ease,visibility 0s linear 0s}
.dsh-np-card[data-minimized=true] .dsh-np-body{opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,visibility 0s linear .16s}
.dsh-np-tools{display:flex;align-items:center;gap:4px;flex:none;padding:0 2px 7px;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08))}
.dsh-np-selectall{display:inline-flex;align-items:center;gap:6px;min-width:0;cursor:pointer;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;white-space:nowrap}
.dsh-np-selectall input{width:14px;height:14px;margin:0;accent-color:var(--np-accent);cursor:pointer;flex:none}
.dsh-np-selectall input:disabled{cursor:default;opacity:.45}
.dsh-np-selcount{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.dsh-np-list{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;padding:8px 2px 8px 0;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dsh-np-seg{display:flex;flex-direction:column;flex:none;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:10px;background:var(--np-surface-2);transition:border-color .12s,background .12s,opacity .12s;animation:dsh-np-item-in .16s ease-out}
.dsh-np-seg[data-selected=true]{border-color:var(--np-accent);background:color-mix(in srgb,var(--np-accent) 6%,var(--np-surface-2));box-shadow:0 0 0 1px var(--np-accent) inset}
.dsh-np-seg[data-archived=true]{border-style:dashed;background:transparent;opacity:.82;animation:none}
.dsh-np-seg-head{display:flex;align-items:center;gap:3px;flex:none;min-height:30px;padding:3px 5px 0 7px;box-sizing:border-box}
.dsh-np-check{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;cursor:pointer}
.dsh-np-check input{width:14px;height:14px;margin:0;accent-color:var(--np-accent);cursor:pointer}
.dsh-np-index{flex:none;color:var(--dsw-alias-label-caption,#9aa3b2);font-size:10px;font-weight:600;letter-spacing:.04em;font-variant-numeric:tabular-nums}
.dsh-np-archived-chip{flex:none;padding:0 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10px;line-height:16px}
.dsh-np-segbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background .12s,color .12s,opacity .12s;opacity:.8}
.dsh-np-segbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430);opacity:1}
.dsh-np-segbtn[data-danger=true]:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#e25555);background:var(--dsw-alias-interactive-bg-hover-danger,rgb(236 19 19/.05))}
.dsh-np-segbtn:disabled{opacity:.3;cursor:default}
.dsh-np-seg-text{display:block;width:100%;box-sizing:border-box;padding:2px 10px 8px;border:0;outline:0;resize:none;background:transparent;color:inherit;font-family:${FONT_STACK};font-size:13px;line-height:1.6;min-height:26px;max-height:240px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
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
@keyframes dsh-np-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dsh-np-rise{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes dsh-np-item-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@keyframes dsh-np-spin{to{transform:rotate(360deg)}}
body[data-ds-dark-theme] .dsh-np-card{--np-accent-fg:#0f1115;box-shadow:0 18px 48px rgb(0 0 0/.55),0 0 0 .5px rgb(255 255 255/.07)}
body[data-ds-dark-theme] .dsh-np-seg[data-selected=true]{background:color-mix(in srgb,var(--np-accent) 14%,var(--dsw-alias-bg-layer-2,#2c2c2e))}
body[data-ds-dark-theme] .dsh-np-btn[data-accent=true]:hover:not(:disabled){background:color-mix(in srgb,var(--np-accent) 84%,#fff)}
body[data-ds-dark-theme] .dsh-np-seg[data-archived=true]{opacity:.7}
@media (prefers-reduced-motion:reduce){.dsh-np-card,.dsh-np-body,.dsh-np-archive,.dsh-np-restore,.dsh-np-seg,.dsh-np-toast{transition:none!important;animation:none!important}.dsh-np-dot[data-state=saving]{animation:none}.dsh-np-img-spinner{animation:none}}`;

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

    function newSegment(text) {
      return { id: newSegmentId(), text, images: [], archived: false, archivedAt: null };
    }

    function serializeSegments(segments) {
      return segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
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
          element.style.height = `${Math.min(240, Math.max(26, height))}px`;
        }
      } catch {
        /* A non-layout shim (tests) may not expose scrollHeight. */
      }
    }

    function workspaceName(root) {
      const parts = String(root ?? '').split(/[\\/]+/u).filter(Boolean);
      return parts.length === 0 ? String(root ?? '') : parts[parts.length - 1];
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
      const widthLimit = Math.max(240, vw - 16);
      const heightLimit = Math.max(180, vh - 16);
      const width = Math.min(Math.max(MIN_W, Number(ui.width) || DEFAULT_W), widthLimit);
      const height = Math.min(Math.max(MIN_H, Number(ui.height) || DEFAULT_H), heightLimit);
      const displayHeight = ui.minimized ? HEAD_H : height;
      const x = ui.x === null || ui.x === undefined
        ? vw - width - 24
        : Math.min(Math.max(8, ui.x), Math.max(8, vw - width - 8));
      const y = ui.y === null || ui.y === undefined
        ? vh - displayHeight - 24
        : Math.min(Math.max(8, ui.y), Math.max(8, vh - displayHeight - 8));
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
      const [ui, setUi] = useState(readStoredUi);
      const [sending, setSending] = useState(false);
      const [resizing, setResizing] = useState(false);
      const [uploading, setUploading] = useState({});
      const [dragSegment, setDragSegment] = useState('');

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
      const undoRef = useRef(null);

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
          setStatus('idle');
          setError('');
          return undefined;
        }
        if (dirtyRef.current && rootRef.current !== '' && rootRef.current !== binding.cwd) {
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
              let value = normalizeServerSegments(data);
              if (value.length === 0) value = [newSegment('')];
              segmentsRef.current = value;
              setSegments(value);
              setSelection(new Set());
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

      // Keyboard ------------------------------------------------------------
      useEffect(() => {
        const onKeyDown = (event) => {
          const chord = event.ctrlKey || event.metaKey;
          if (!chord || !event.shiftKey) return;
          if (event.key !== 'N' && event.key !== 'n') return;
          event.preventDefault();
          setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown, true);
          clearTimer();
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
      }, []);

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
          fetchNote(root, sessionId)
            .then((data) => {
              if (rootRef.current !== root || dirtyRef.current) return;
              if (typeof data.mtimeMs === 'number' && data.mtimeMs === versionRef.current) return;
              let value = normalizeServerSegments(data);
              if (value.length === 0) value = [newSegment('')];
              segmentsRef.current = value;
              setSegments(value);
              setSelection(new Set());
              versionRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
              setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : null);
              setStatus('saved');
            })
            .catch(() => {});
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
        const next = segmentsRef.current.map((segment) => (segment.id === id ? { ...segment, text: value } : segment));
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

      const removeImage = (id, pathValue) => {
        const next = segmentsRef.current.map((segment) => {
          if (segment.id !== id) return segment;
          const images = Array.isArray(segment.images) ? segment.images.filter((image) => image.path !== pathValue) : [];
          return { ...segment, images };
        });
        commitSegments(next);
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
        event.stopPropagation?.();
        attachImages(id, files, 'paste');
      };

      const onSegmentDrop = (event, id) => {
        const files = clipboardImageFiles(event?.dataTransfer);
        setDragSegment('');
        if (files.length === 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
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
        const url = imageUrl(image.path, rootRef.current);
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
          /* Popups may be blocked; the path remains available in the title. */
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
        const next = [];
        for (const segment of segmentsRef.current) {
          if (segment.id === id) {
            next.push({ ...segment, text: head });
            next.push(nextSegment);
          } else {
            next.push(segment);
          }
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
        commitSegments(record.snapshot);
        setToast(null);
      };

      const deleteArchived = (id) => {
        const target = segmentsRef.current.find((segment) => segment.id === id && segment.archived === true);
        if (target === undefined) return;
        undoRef.current = { snapshot: segmentsRef.current };
        const next = segmentsRef.current.filter((segment) => segment.id !== id);
        commitSegments(next);
        showToast(t('deletedToast'), { label: t('undo'), onClick: undoLast });
      };

      const clearArchive = () => {
        const archived = segmentsRef.current.filter((segment) => segment.archived === true);
        if (archived.length === 0) return;
        undoRef.current = { snapshot: segmentsRef.current };
        const next = segmentsRef.current.filter((segment) => segment.archived !== true);
        commitSegments(next);
        showToast(t('clearedArchive', { n: archived.length }), { label: t('undo'), onClick: undoLast });
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

      /**
       * Send text into the current session. Prefers the documented scoped
       * conversation service; falls back to the session face with a local echo.
       * @returns {Promise<boolean>} whether a prompt was accepted
       */
      const sendToSession = async (value) => {
        const sessionId = rootSessionRef.current !== '' ? rootSessionRef.current : bindingRef.current?.id;
        if (typeof sessionId !== 'string' || sessionId === '') return false;
        const sessions = ctx.get('sessions');
        if (sessions === undefined || sessions === null) return false;
        if (typeof sessions.scope === 'function') {
          const scoped = sessions.scope(sessionId);
          const conversation = scoped === undefined || scoped === null
            ? undefined
            : typeof scoped.get === 'function' ? scoped.get('conversation') : scoped.conversation;
          if (conversation !== undefined && conversation !== null && typeof conversation.send === 'function') {
            await conversation.send(value);
            return true;
          }
        }
        if (typeof sessions.binding === 'function') {
          const liveBinding = sessions.binding(sessionId);
          const session = liveBinding?.session;
          if (session !== undefined && session !== null && typeof session.prompt === 'function') {
            let echo;
            try {
              echo = typeof session.beginSubmission === 'function'
                ? session.beginSubmission({ mode: 'queue', text: value, attachments: [] })
                : undefined;
            } catch {
              echo = undefined;
            }
            try {
              const result = await session.prompt([{ type: 'text', text: value }], 'queue', undefined, echo?.requestId);
              if (result !== undefined && result !== null && result.ok === false) {
                throw new Error(result.error?.message ?? 'prompt failed');
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
          }
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

      const copyAll = async () => {
        const value = mergedText(segmentsRef.current);
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
          const x = Math.min(Math.max(8, start.x + moveEvent.clientX - start.px), Math.max(8, vw - ui.width - 8));
          const y = Math.min(Math.max(8, start.y + moveEvent.clientY - start.py), Math.max(8, vh - height - 8));
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
        event.stopPropagation?.();
        const start = { px: event.clientX, py: event.clientY, width: ui.width, height: ui.height };
        resizeRef.current = start;
        setResizing(true);
        const move = (moveEvent) => {
          const vw = window.innerWidth || 1280;
          const vh = window.innerHeight || 800;
          const width = Math.min(Math.max(MIN_W, start.width + moveEvent.clientX - start.px), Math.max(MIN_W, vw - 16));
          const height = Math.min(Math.max(MIN_H, start.height + moveEvent.clientY - start.py), Math.max(MIN_H, vh - 16));
          setUi((previous) => {
            const maxX = Math.max(8, vw - width - 8);
            const maxY = Math.max(8, vh - height - 8);
            return {
              ...previous,
              width,
              height,
              x: typeof previous.x === 'number' ? Math.min(previous.x, maxX) : previous.x,
              y: typeof previous.y === 'number' ? Math.min(previous.y, maxY) : previous.y,
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
      const totalChars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
      const displayWidth = ui.width;
      const displayHeight = ui.minimized ? HEAD_H : ui.height;
      const fallbackX = Math.max(8, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - displayWidth - 24);
      const fallbackY = Math.max(8, ((typeof window !== 'undefined' && window.innerHeight) || 800) - displayHeight - 24);
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

      const archiveButtonTitle = ui.showArchive
        ? t('hideArchive', { n: archivedSegments.length })
        : t('showArchive', { n: archivedSegments.length });

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
            title: t('copy'),
            'aria-label': t('copy'),
            disabled: totalChars === 0,
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
          archivedSegments.length > 0
            ? h('span', { className: 'dsh-np-badge' }, String(archivedSegments.length))
            : null,
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
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            title: selectedCount > 0 ? t('insertSelected', { n: selectedCount }) : t('insert'),
            'aria-label': t('insert'),
            disabled: selectedCount === 0,
            onClick: () => insertSegments(selectedActive),
          },
          h(InsertIcon, { size: 14 }),
        ),
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
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-btn',
            'data-accent': 'true',
            title: selectedCount > 0
              ? (sending ? t('sending') : t('sendSelected', { n: selectedCount }))
              : t('send'),
            'aria-label': t('send'),
            disabled: selectedCount === 0 || sending,
            onClick: () => sendSegments(selectedActive),
          },
          h(SendIcon, { size: 14 }),
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
        return h(
          'article',
          {
            key: segment.id,
            className: 'dsh-np-seg',
            'data-seg-id': segment.id,
            'data-archived': 'false',
            'data-selected': selected.has(segment.id) ? 'true' : 'false',
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
            h('span', { className: 'dsh-np-index' }, String(index + 1).padStart(2, '0')),
            h('span', { className: 'dsh-np-spacer' }),
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
                title: t('insertSegment'),
                'aria-label': t('insertSegment'),
                disabled: empty,
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
                disabled: empty,
                onClick: () => replaceSegments([segment]),
              },
              h(ReplaceIcon, { size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                title: t('sendSegment'),
                'aria-label': t('sendSegment'),
                disabled: empty || sending,
                onClick: () => sendSegments([segment]),
              },
              h(SendIcon, { size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-np-segbtn',
                title: t('archiveSegment'),
                'aria-label': t('archiveSegment'),
                onClick: () => archiveSegment(segment.id),
              },
              h(ArchiveIcon, { size: 14 }),
            ),
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
              placeholder: index === 0 ? t('placeholder') : t('segmentPlaceholder'),
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
        h('span', { className: 'dsh-np-hint', title: t('hint') }, t('hint')),
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
