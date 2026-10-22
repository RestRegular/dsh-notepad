/**
 * dsh-notepad — Client half.
 *
 * Registers one floating notepad into `shell.overlay`. The panel is scoped to
 * the workspace of the session currently retained by the main view, so every
 * session opened from the same workspace shows the same note.
 *
 * Data lives on the Host side at `<workspace>/.dsh/notepad.json` through the
 * same-origin route `/dsh-notepad/api/note`; only the widget's position and
 * minimized/hidden state are kept in localStorage.
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
    const CARD_W = 372;
    const CARD_H = 336;
    const HEAD_H = 42;
    const SAVE_DELAY = 500;

    // ------------------------------------------------------------------
    // Copy
    // ------------------------------------------------------------------
    const DICT = {
      zh: {
        title: '记事本',
        editor: '记事本内容',
        placeholder: '记录开发中遇到的问题，或下一阶段要做的事……',
        loading: '读取中…',
        empty: '还没有内容',
        unsaved: '未保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        retry: '重试',
        insert: '插入到输入框',
        inserted: '已插入输入框',
        insertEmpty: '记事本还是空的',
        insertUnavailable: '输入框暂不可用，内容已复制',
        copy: '复制全部',
        copied: '已复制',
        copyFailed: '复制失败',
        minimize: '最小化',
        expand: '展开',
        hide: '隐藏（Ctrl+Shift+N）',
        show: '显示记事本（Ctrl+Shift+N）',
        chars: '{n} 字符',
        hint: 'Ctrl+Enter 插入 · Ctrl+Shift+N 隐藏',
        workspace: '工作区',
      },
      en: {
        title: 'Notepad',
        editor: 'Notepad content',
        placeholder: 'Jot down problems, or what to build next…',
        loading: 'Loading…',
        empty: 'Nothing here yet',
        unsaved: 'Unsaved',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        retry: 'Retry',
        insert: 'Insert into composer',
        inserted: 'Inserted',
        insertEmpty: 'The notepad is empty',
        insertUnavailable: 'Composer unavailable; copied instead',
        copy: 'Copy all',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        minimize: 'Minimize',
        expand: 'Expand',
        hide: 'Hide (Ctrl+Shift+N)',
        show: 'Show notepad (Ctrl+Shift+N)',
        chars: '{n} chars',
        hint: 'Ctrl+Enter inserts · Ctrl+Shift+N hides',
        workspace: 'Workspace',
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

    function InsertIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M8 2.2v6.6M5.6 6.6 8 9l2.4-2.4',
          stroke: 'currentColor', strokeWidth: 1.35,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.1 10.2v1.3c0 .9.7 1.6 1.6 1.6h6.6c.9 0 1.6-.7 1.6-1.6v-1.3',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
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

    function MinusIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M3.8 8h8.4',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
      );
    }

    function ChevronUpIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M4.2 9.8 8 6l3.8 3.8',
          stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    function EyeOffIcon({ size = 16 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 16 16' },
        h('path', {
          d: 'M2.4 8s2.1-3.4 5.6-3.4S13.6 8 13.6 8s-2.1 3.4-5.6 3.4S2.4 8 2.4 8Z',
          stroke: 'currentColor', strokeWidth: 1.25,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8, cy: 8, r: 1.55, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', {
          d: 'M3 3l10 10',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
        }),
      );
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    const CSS = `.dsh-np-card{position:fixed;z-index:30;display:flex;flex-direction:column;box-sizing:border-box;width:${CARD_W}px;max-width:calc(100vw - 16px);height:${CARD_H}px;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:14px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2430);box-shadow:0 20px 50px rgb(15 23 42/.22),0 2px 8px rgb(15 23 42/.08);overflow:hidden;backdrop-filter:saturate(1.2) blur(10px);font-size:13px;line-height:1.5}
.dsh-np-card[data-minimized=true]{height:${HEAD_H}px}
.dsh-np-head{display:flex;align-items:center;gap:7px;flex:none;height:${HEAD_H}px;padding:0 8px 0 12px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1,rgb(15 23 42/.08));cursor:grab;user-select:none;touch-action:none;background:var(--dsw-alias-bg-overlay,#fff);background:linear-gradient(180deg,var(--dsw-alias-bg-overlay,#fff),color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 88%,var(--dsw-alias-bg-base,#f7f8fb)))}
.dsh-np-card[data-minimized=true] .dsh-np-head{border-bottom-color:transparent}
.dsh-np-head:active{cursor:grabbing}
.dsh-np-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,#9aa3b2);transition:background .15s}
.dsh-np-dot[data-state=dirty]{background:#f5a524}
.dsh-np-dot[data-state=saving]{background:#f5a524;animation:dsh-np-pulse 1s ease-in-out infinite}
.dsh-np-dot[data-state=error]{background:#e25555}
.dsh-np-dot[data-state=saved]{background:#2fb36d}
.dsh-np-title{flex:none;font-size:12.5px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.dsh-np-workspace{min-width:0;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10.5px;line-height:16px}
.dsh-np-spacer{flex:1 1 auto;min-width:0}
.dsh-np-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;transition:background .12s,color .12s}
.dsh-np-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-primary,#1f2430)}
.dsh-np-btn[data-accent=true]{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.dsh-np-btn[data-accent=true]:hover{background:var(--dsw-alias-brand-primary-hover,#3d57e8);color:#fff}
.dsh-np-btn:disabled{opacity:.4;cursor:default;background:var(--dsw-alias-interactive-bg-hover,rgb(38 49 72/.06));color:var(--dsw-alias-label-tertiary,#6b7280)}
.dsh-np-body{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;padding:10px 12px 0}
.dsh-np-text{flex:1 1 auto;width:100%;min-height:0;padding:0;border:0;outline:0;resize:none;background:transparent;color:inherit;font:12.5px/1.65 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;tab-size:2}
.dsh-np-text::placeholder{color:var(--dsw-alias-label-caption,#9aa3b2)}
.dsh-np-text:disabled{opacity:.65}
.dsh-np-foot{display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px 9px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:10.5px;line-height:14px}
.dsh-np-status{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-np-status[data-state=error]{color:#d94a4a}
.dsh-np-retry{flex:none;padding:0;border:0;background:none;color:var(--dsw-alias-link,#4d6bfe);font:inherit;cursor:pointer;text-decoration:underline}
.dsh-np-count{flex:none}
.dsh-np-hint{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.dsh-np-toast{position:absolute;left:50%;bottom:38px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));box-shadow:0 8px 24px rgb(15 23 42/.18);color:var(--dsw-alias-label-primary,#1f2430);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:dsh-np-rise .16s ease-out}
.dsh-np-restore{position:fixed;right:16px;bottom:16px;z-index:30;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgb(15 23 42/.12));border-radius:10px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-secondary,#4b5563);box-shadow:0 8px 24px rgb(15 23 42/.16);cursor:pointer;opacity:.86;transition:opacity .12s,transform .12s}
.dsh-np-restore:hover{opacity:1;transform:translateY(-1px)}
@keyframes dsh-np-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dsh-np-rise{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion:reduce){.dsh-np-toast,.dsh-np-restore{animation:none;transition:none}.dsh-np-dot[data-state=saving]{animation:none}}`;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function workspaceName(root) {
      const parts = String(root ?? '').split(/[\\/]+/u).filter(Boolean);
      return parts.length === 0 ? String(root ?? '') : parts[parts.length - 1];
    }

    function readStoredUi() {
      const base = { x: null, y: null, minimized: false, hidden: false };
      try {
        const raw = window.localStorage?.getItem(UI_KEY);
        if (typeof raw !== 'string' || raw === '') return base;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return base;
        return {
          x: Number.isFinite(parsed.x) ? parsed.x : null,
          y: Number.isFinite(parsed.y) ? parsed.y : null,
          minimized: parsed.minimized === true,
          hidden: parsed.hidden === true,
        };
      } catch {
        return base;
      }
    }

    function clampUi(ui) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const width = Math.min(CARD_W, Math.max(200, vw - 16));
      const height = ui.minimized ? HEAD_H : CARD_H;
      const x = ui.x === null || ui.x === undefined
        ? vw - width - 24
        : Math.min(Math.max(8, ui.x), Math.max(8, vw - width - 8));
      const y = ui.y === null || ui.y === undefined
        ? vh - height - 24
        : Math.min(Math.max(8, ui.y), Math.max(8, vh - height - 8));
      return { ...ui, x, y };
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

    async function saveNote(root, sessionId, text) {
      const response = await fetch(`${API}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, sessionId, text }),
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
      const [text, setText] = useState('');
      const [loaded, setLoaded] = useState(false);
      const [status, setStatus] = useState('idle');
      const [error, setError] = useState('');
      const [savedAt, setSavedAt] = useState(null);
      const [toast, setToast] = useState(null);
      const [ui, setUi] = useState(readStoredUi);

      const bindingRef = useRef(null);
      const rootSessionRef = useRef('');
      const textRef = useRef('');
      const rootRef = useRef('');
      const versionRef = useRef(null);
      const dirtyRef = useRef(false);
      const timerRef = useRef(0);
      const toastTimerRef = useRef(0);
      const seqRef = useRef(0);
      const saveNowRef = useRef(null);
      const inputActionsRef = useRef(null);
      const taRef = useRef(null);
      const dragRef = useRef(null);

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

      // Position ------------------------------------------------------------
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

      const showToast = (message) => {
        setToast({ id: Date.now(), message });
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 1800);
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
        const body = textRef.current;
        const seq = ++seqRef.current;
        dirtyRef.current = false;
        setStatus('saving');
        setError('');
        try {
          const data = await saveNote(root, sessionId, body);
          if (seq !== seqRef.current || rootRef.current !== root) return;
          if (typeof data.mtimeMs === 'number') versionRef.current = data.mtimeMs;
          setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : Date.now());
          if (textRef.current === body) {
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

      // Load on workspace/session change ------------------------------------
      useEffect(() => {
        if (binding === null) {
          rootRef.current = '';
          rootSessionRef.current = '';
          setLoaded(false);
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
        setLoaded(false);
        setStatus('loading');
        setError('');
        setText('');
        textRef.current = '';
        fetchNote(root, binding.id)
          .then((data) => {
            if (cancelled || rootRef.current !== root) return;
            const value = typeof data.text === 'string' ? data.text : '';
            textRef.current = value;
            setText(value);
            versionRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
            setSavedAt(typeof data.mtimeMs === 'number' ? data.mtimeMs : null);
            dirtyRef.current = false;
            setLoaded(true);
            setStatus('saved');
          })
          .catch((reason) => {
            if (cancelled || rootRef.current !== root) return;
            setLoaded(true);
            setStatus('error');
            setError(String(reason?.message || reason));
          });
        return () => {
          cancelled = true;
        };
      }, [binding === null ? '' : binding.id, binding === null ? '' : binding.cwd]);

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
          if (typeof document !== 'undefined' && document.activeElement === taRef.current) return;
          fetchNote(root, sessionId)
            .then((data) => {
              if (rootRef.current !== root || dirtyRef.current) return;
              if (typeof data.mtimeMs === 'number' && data.mtimeMs === versionRef.current) return;
              const value = typeof data.text === 'string' ? data.text : '';
              textRef.current = value;
              setText(value);
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

      // Actions -------------------------------------------------------------
      const onChange = (event) => {
        const value = event.target.value;
        textRef.current = value;
        setText(value);
        dirtyRef.current = true;
        setStatus('dirty');
        setError('');
        scheduleSave();
      };

      const insertIntoComposer = async () => {
        const value = textRef.current;
        if (value.trim() === '') {
          showToast(t('insertEmpty'));
          return;
        }
        const actions = inputActionsRef.current;
        if (
          actions !== null &&
          actions !== undefined &&
          typeof actions.captureInsertion === 'function' &&
          typeof actions.insertText === 'function'
        ) {
          try {
            const span = actions.captureInsertion();
            if (actions.insertText(value, span) === true) {
              actions.persistDraft?.();
              showToast(t('inserted'));
              return;
            }
          } catch {
            /* fall through to copy */
          }
        }
        const copied = await copyText(value);
        showToast(copied ? t('insertUnavailable') : t('copyFailed'));
      };

      const copyAll = async () => {
        const value = textRef.current;
        if (value === '') {
          showToast(t('insertEmpty'));
          return;
        }
        showToast((await copyText(value)) ? t('copied') : t('copyFailed'));
      };

      const toggleMinimize = () => {
        setUi((previous) => clampUi({ ...previous, minimized: !previous.minimized }));
      };

      const toggleHidden = () => {
        setUi((previous) => clampUi({ ...previous, hidden: !previous.hidden }));
      };

      const onTextKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          insertIntoComposer();
        }
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
          const width = Math.min(CARD_W, Math.max(200, vw - 16));
          const height = ui.minimized ? HEAD_H : CARD_H;
          const x = Math.min(Math.max(8, start.x + moveEvent.clientX - start.px), Math.max(8, vw - width - 8));
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

      // Render --------------------------------------------------------------
      if (binding === null || present !== true) return null;

      if (ui.hidden === true) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-np-restore',
            title: t('show'),
            'aria-label': t('show'),
            onClick: () => setUi((previous) => clampUi({ ...previous, hidden: false })),
          },
          h(NotepadIcon, { size: 16 }),
        );
      }

      const fallbackX = Math.max(8, ((typeof window !== 'undefined' && window.innerWidth) || 1280) - CARD_W - 24);
      const fallbackY = Math.max(8, ((typeof window !== 'undefined' && window.innerHeight) || 800) - CARD_H - 24);
      const left = typeof ui.x === 'number' ? ui.x : fallbackX;
      const top = typeof ui.y === 'number' ? ui.y : fallbackY;

      let statusText = '';
      if (status === 'loading') statusText = t('loading');
      else if (status === 'saving') statusText = t('saving');
      else if (status === 'dirty') statusText = t('unsaved');
      else if (status === 'error') statusText = t('saveFailed');
      else if (status === 'saved') {
        const clock = clockLabel(savedAt);
        statusText = clock === '' ? t('saved') : `${t('saved')} · ${clock}`;
      } else statusText = t('empty');

      return h(
        'section',
        {
          className: 'dsh-np-card',
          'data-dsh-notepad': 'true',
          'data-minimized': ui.minimized ? 'true' : 'false',
          'data-state': status,
          style: { left: `${left}px`, top: `${top}px` },
          role: 'complementary',
          'aria-label': t('title'),
        },
        h(
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
              'data-accent': 'true',
              title: t('insert'),
              'aria-label': t('insert'),
              disabled: text.trim() === '',
              onClick: insertIntoComposer,
            },
            h(InsertIcon, { size: 15 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              title: t('copy'),
              'aria-label': t('copy'),
              disabled: text === '',
              onClick: copyAll,
            },
            h(CopyIcon, { size: 15 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              title: ui.minimized ? t('expand') : t('minimize'),
              'aria-label': ui.minimized ? t('expand') : t('minimize'),
              onClick: toggleMinimize,
            },
            h(ui.minimized ? ChevronUpIcon : MinusIcon, { size: 15 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-np-btn',
              title: t('hide'),
              'aria-label': t('hide'),
              onClick: toggleHidden,
            },
            h(EyeOffIcon, { size: 15 }),
          ),
        ),
        ui.minimized
          ? null
          : h(
              'div',
              { className: 'dsh-np-body' },
              h('textarea', {
                ref: taRef,
                className: 'dsh-np-text',
                value: text,
                placeholder: t('placeholder'),
                spellCheck: false,
                maxLength: 160000,
                'aria-label': t('editor'),
                disabled: status === 'loading',
                onChange,
                onKeyDown: onTextKeyDown,
                onBlur: () => {
                  if (dirtyRef.current) saveNowRef.current?.();
                },
              }),
              h(
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
                      onClick: () => saveNowRef.current?.({ force: true }),
                    }, t('retry'))
                  : null,
                h('span', { className: 'dsh-np-count' }, t('chars', { n: text.length })),
                h('span', { className: 'dsh-np-hint', title: t('hint') }, t('hint')),
              ),
              toast === null ? null : h('div', { className: 'dsh-np-toast', role: 'status' }, toast.message),
            ),
      );
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
