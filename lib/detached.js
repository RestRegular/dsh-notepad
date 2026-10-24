/**
 * dsh-notepad — standalone detached window.
 *
 * This page is served by the plugin-owned loopback server, not by the DSH web
 * app, so it keeps working when the DSH interface is minimized or its tab is
 * closed. It talks to the same workspace note file through the token-guarded
 * `/api` endpoints on this origin.
 */

const TOKEN = document.body.dataset.token ?? '';
const ROOT = document.body.dataset.root ?? '';
const API = '/api';
const CACHE_PREFIX = 'dsh-notepad.detached.note.';
const HEARTBEAT_MS = 4000;
const SAVE_DELAY = 550;

const DICT = {
  zh: {
    title: '记事本',
    workspace: '工作区',
    loading: '读取中…',
    empty: '还没有内容',
    add: '新建分段',
    addHint: 'Enter 新建分段 · Shift+Enter 分段内换行',
    placeholder: '记录开发中遇到的问题，或下一阶段要做的事……',
    titlePlaceholder: '分段标题（可选）',
    saved: '已保存',
    saving: '保存中…',
    dirty: '未保存',
    saveFailed: '保存失败',
    loadFailed: '读取失败',
    save: '保存记事本',
    copyAll: '复制全部',
    copied: '已复制',
    copy: '复制',
    archive: '归档',
    archived: '归档',
    restore: '恢复',
    delete: '删除',
    optimize: 'AI 优化此段',
    optimizing: '优化中…',
    optimizeFailed: '优化失败',
    optimizeEmpty: '没有可优化的文字',
    confirmTitle: '删除这个分段？',
    confirmBody: '删除后无法恢复。分段里的文字和图片引用会一起移除。',
    confirmCancel: '取消',
    confirmOk: '删除',
    deleted: '已删除',
    archivedToast: '已归档',
    restoredToast: '已恢复',
    archiveTitle: '归档',
    archiveEmpty: '还没有归档的分段',
    chars: '{n} 字符',
    segments: '{n} 段',
    images: '{n} 张图片',
    reattach: '收回面板',
    retiredTitle: '已收回面板',
    retiredBody: '记事本已回到 DSH 浮窗，这个独立窗口可以关闭了。',
    connOnline: 'DSH 已连接',
    connOffline: 'DSH 已断开',
    connRetired: '已收回',
    connConnecting: '连接中…',
    offlineHint: 'DSH 已断开；修改会保留在本窗口，连接恢复后可再次保存。',
    copyFailed: '复制失败',
    preview: '图片预览',
  },
  en: {
    title: 'Notepad',
    workspace: 'Workspace',
    loading: 'Loading…',
    empty: 'Nothing here yet',
    add: 'New segment',
    addHint: 'Enter creates a segment · Shift+Enter adds a line break',
    placeholder: 'Jot down problems, or what to build next…',
    titlePlaceholder: 'Segment title (optional)',
    saved: 'Saved',
    saving: 'Saving…',
    dirty: 'Unsaved',
    saveFailed: 'Save failed',
    loadFailed: 'Load failed',
    save: 'Save notepad',
    copyAll: 'Copy all',
    copied: 'Copied',
    copy: 'Copy',
    archive: 'Archive',
    archived: 'Archived',
    restore: 'Restore',
    delete: 'Delete',
    optimize: 'Improve this segment with AI',
    optimizing: 'Improving…',
    optimizeFailed: 'Improve failed',
    optimizeEmpty: 'Nothing to improve',
    confirmTitle: 'Delete this segment?',
    confirmBody: 'This cannot be undone. The text and image references in the segment will be removed too.',
    confirmCancel: 'Cancel',
    confirmOk: 'Delete',
    deleted: 'Deleted',
    archivedToast: 'Archived',
    restoredToast: 'Restored',
    archiveTitle: 'Archive',
    archiveEmpty: 'Nothing archived yet',
    chars: '{n} chars',
    segments: '{n} segments',
    images: '{n} image(s)',
    reattach: 'Return to panel',
    retiredTitle: 'Returned to the panel',
    retiredBody: 'The notepad is back in the DSH floating panel. You can close this window.',
    connOnline: 'DSH connected',
    connOffline: 'DSH disconnected',
    connRetired: 'Returned',
    connConnecting: 'Connecting…',
    offlineHint: 'DSH is disconnected; changes stay in this window and can be saved after it reconnects.',
    copyFailed: 'Could not copy',
    preview: 'Image preview',
  },
};

let config = {
  lang: 'zh',
  theme: 'host',
  uiStyle: 'glass',
  blur: 10,
  font: 'system',
  fontSize: 13,
  maxSegmentHeight: 240,
  saveMode: 'auto',
  buttonGroups: true,
  ai: '',
};
let translate = (key, params) => {
  const dict = DICT[config.lang] ?? DICT.zh;
  let out = dict[key] ?? DICT.zh[key] ?? key;
  if (params !== null && typeof params === 'object') {
    out = out.replace(/\{(\w+)\}/gu, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  }
  return out;
};

let segments = [];
let dirty = false;
let saving = false;
let saveAgain = false;
let saveTimer = 0;
let retired = false;
let online = true;
let heartbeatTimer = 0;
let toastTimer = 0;
let pendingDelete = '';
let lastSavedAt = null;
let loadError = '';
let loaded = false;
let saveSeq = 0;
let revision = 0;
let cacheTimer = 0;

const $ = (id) => document.getElementById(id);
const app = $('app');
const list = $('list');
const titleNode = $('app-title');
const workspaceNode = $('workspace-title');
const statusDot = $('status-dot');
const stateText = $('state-text');
const countText = $('count-text');
const connText = $('conn-text');
const connDot = $('conn-dot');
const connLabel = $('conn-label');
const summary = $('summary');
const saveButton = $('save-button');
const archiveButton = $('archive-button');
const addButton = $('add-button');
const reattachButton = $('reattach-button');
const copyAllButton = $('copy-all-button');
const confirmNode = $('confirm');
const confirmTitle = $('confirm-title');
const confirmBody = document.querySelector('#confirm .np-confirm-body');
const confirmCancel = $('confirm-cancel');
const confirmOk = $('confirm-ok');
const previewNode = $('preview');
const previewImage = $('preview-image');
const previewClose = $('preview-close');
const retiredNode = $('retired');
const toastNode = $('toast');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'html') node.innerHTML = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'style') Object.assign(node.style, value);
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function svg(paths, size = 15, viewBox = '0 0 16 16') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  for (const path of paths) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [name, value] of Object.entries(path)) child.setAttribute(name, String(value));
    node.appendChild(child);
  }
  return node;
}

const ICONS = {
  copy: () => svg([{ d: 'M5.6 3.4h7v7h-7z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }, { d: 'M10.4 12.6h-7v-7', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }]),
  archive: () => svg([{ d: 'M2.6 3.6h10.8v2.8H2.6zM3.6 6.4v6h8.8v-6M6.2 8.8h3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }]),
  restore: () => svg([{ d: 'M3.2 8a4.8 4.8 0 1 0 1.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }, { d: 'M3 3.2v3.1h3.1', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]),
  trash: () => svg([{ d: 'M3.2 4.4h9.6M6 4.4V3.1h4v1.3M4.4 4.4l.6 8.4h6l.6-8.4M6.6 6.7v3.8M9.4 6.7v3.8', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.25, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]),
  sparkle: () => svg([{ d: 'M8 2.4l1.1 3.2 3.2 1.1-3.2 1.1L8 11l-1.1-3.2L3.7 6.7l3.2-1.1z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }, { d: 'M12.2 10.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z', fill: 'currentColor' }]),
  fold: () => svg([{ d: 'M4.2 6.2 8 10l3.8-3.8', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]),
  open: () => svg([{ d: 'M9.4 3.2h3.4v3.4M12.8 3.2 7.6 8.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, { d: 'M12.4 9.4v2.3c0 .7-.6 1.3-1.3 1.3H4.6c-.7 0-1.3-.6-1.3-1.3V5.2c0-.7.6-1.3 1.3-1.3h2.3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }]),
};

function apiUrl(pathname, params = {}) {
  const query = new URLSearchParams({ token: TOKEN, root: ROOT, ...params });
  return `${API}${pathname}?${query.toString()}`;
}

async function api(pathname, options = {}) {
  const { method = 'GET', body, params } = options;
  const response = await fetch(apiUrl(pathname, params), {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function baseName(root) {
  const parts = String(root ?? '').split(/[\\/]+/u).filter(Boolean);
  return parts.length === 0 ? String(root ?? '') : parts[parts.length - 1];
}

function imageUrl(image) {
  return apiUrl('/image', { path: image.path });
}

function imageMarkdown(image) {
  return `![${image.name ?? 'image'}](${image.path})`;
}

function segmentContent(segment) {
  const parts = [];
  if (String(segment.text ?? '').trim() !== '') parts.push(segment.text);
  for (const image of Array.isArray(segment.images) ? segment.images : []) parts.push(imageMarkdown(image));
  return parts.join('\n');
}

function allActive() {
  return segments.filter((segment) => segment.archived !== true);
}

function sortedArchive() {
  return segments
    .filter((segment) => segment.archived === true)
    .slice()
    .sort((a, b) => (Date.parse(b.archivedAt ?? '') || 0) - (Date.parse(a.archivedAt ?? '') || 0));
}

function countImages() {
  return segments.reduce((sum, segment) => sum + (Array.isArray(segment.images) ? segment.images.length : 0), 0);
}

function setStatus(state, text) {
  statusDot.dataset.state = state;
  stateText.dataset.state = state;
  stateText.textContent = text;
}

function setConnection(state, label) {
  connText.dataset.state = state;
  connLabel.textContent = label;
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.hidden = true;
    toastTimer = 0;
  }, 2200);
}

function applyConfig() {
  document.documentElement.dataset.npTheme = config.theme;
  document.documentElement.dataset.npStyle = config.uiStyle;
  document.documentElement.lang = config.lang === 'en' ? 'en' : 'zh-CN';
  const fonts = {
    system: '"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif',
    sans: '"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif',
    serif: 'Georgia,Cambria,"Songti SC","Noto Serif CJK SC","Times New Roman",serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Code",monospace',
  };
  document.documentElement.style.setProperty('--np-font', fonts[config.font] ?? fonts.system);
  document.documentElement.style.setProperty('--np-font-size', `${config.fontSize}px`);
  document.documentElement.style.setProperty('--np-seg-max', `${config.maxSegmentHeight}px`);
  document.documentElement.style.setProperty('--np-blur', `${config.blur}px`);
  translate = (key, params) => {
    const dict = DICT[config.lang] ?? DICT.zh;
    let out = dict[key] ?? DICT.zh[key] ?? key;
    if (params !== null && typeof params === 'object') {
      out = out.replace(/\{(\w+)\}/gu, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }
    return out;
  };
  titleNode.textContent = translate('title');
  reattachButton.title = translate('reattach');
  reattachButton.querySelector('span').textContent = translate('reattach');
  addButton.title = translate('add');
  addButton.setAttribute('aria-label', translate('add'));
  saveButton.title = translate('save');
  saveButton.setAttribute('aria-label', translate('save'));
  archiveButton.title = translate('archiveTitle');
  copyAllButton.textContent = translate('copyAll');
  saveButton.hidden = config.saveMode !== 'manual';
  document.title = `${translate('title')} · ${workspaceNode.textContent || baseName(ROOT)}`;
}

function autoGrow(textarea) {
  try {
    textarea.style.height = 'auto';
    const height = Number(textarea.scrollHeight);
    if (Number.isFinite(height) && height > 0) {
      const limit = Math.max(80, Number(config.maxSegmentHeight) || 240);
      textarea.style.height = `${Math.min(limit, Math.max(40, height))}px`;
      textarea.style.overflowY = height > limit ? 'auto' : 'hidden';
    }
  } catch {
    /* ignore */
  }
}

function focusSegment(id, caret = 'end') {
  requestAnimationFrame(() => {
    const textarea = list.querySelector(`textarea[data-id="${CSS.escape(id)}"]`);
    if (textarea === null) return;
    textarea.focus();
    try {
      const position = caret === 'start' ? 0 : textarea.value.length;
      textarea.setSelectionRange(position, position);
      textarea.scrollIntoView({ block: 'nearest' });
    } catch {
      /* ignore */
    }
  });
}

function updateFooter() {
  const active = allActive();
  const chars = segments.reduce((sum, segment) => sum + (typeof segment.text === 'string' ? segment.text.length : 0), 0);
  const images = countImages();
  countText.textContent = `${translate('chars', { n: chars })} · ${translate('segments', { n: active.length })}`
    + (images > 0 ? ` · ${translate('images', { n: images })}` : '');
  summary.textContent = translate('segments', { n: active.length });
  copyAllButton.disabled = active.length === 0;
}

function statusLabel() {
  if (retired) return [translate('connRetired'), 'retired'];
  if (!online) return [translate('connOffline'), 'offline'];
  return [translate('connOnline'), 'online'];
}

function render() {
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const active = allActive();
  const archived = sortedArchive();

  if (!loaded) {
    list.appendChild(el('div', { class: 'np-empty', text: loadError || translate('loading') }));
  } else if (active.length === 0 && archived.length === 0) {
    list.appendChild(el('div', { class: 'np-empty', text: translate('empty') }));
  }

  active.forEach((segment, index) => list.appendChild(renderCard(segment, index)));

  const add = el('button', { type: 'button', class: 'np-add', title: translate('addHint'), onclick: addSegment });
  add.appendChild(el('span', { text: '+ ' }));
  add.appendChild(el('span', { text: translate('add') }));
  list.appendChild(add);

  if (archiveButton.dataset.active === 'true') {
    const head = el('div', { class: 'np-archive-head' }, [
      el('span', { text: `${translate('archiveTitle')} · ${archived.length}` }),
    ]);
    list.appendChild(head);
    if (archived.length === 0) {
      list.appendChild(el('div', { class: 'np-empty', text: translate('archiveEmpty') }));
    } else {
      archived.forEach((segment) => list.appendChild(renderCard(segment, 0, true)));
    }
  }

  updateFooter();
  const [label, state] = statusLabel();
  setConnection(state, label);
  app.dataset.ready = loaded ? 'true' : 'false';
  requestAnimationFrame(() => {
    list.scrollTop = scrollTop;
  });
}

function renderCard(segment, index, archived = false) {
  const folded = archived && segment.__folded === true;
  const card = el('article', {
    class: 'np-card',
    dataset: { id: segment.id, archived: String(archived), folded: String(folded) },
  });

  const head = el('div', { class: 'np-card-head' });
  if (archived) {
    const fold = el('button', {
      type: 'button',
      class: 'np-card-btn',
      title: folded ? translate('restore') : translate('archive'),
      onclick: () => {
        segment.__folded = !folded;
        render();
      },
    });
    fold.appendChild(ICONS.fold());
    head.appendChild(fold);
    head.appendChild(el('span', { class: 'np-index', text: '·' }));
  } else {
    head.appendChild(el('span', { class: 'np-index', text: String(index + 1) }));
  }

  if (archived) {
    head.appendChild(el('span', {
      class: 'np-title-input',
      text: String(segment.title ?? '').trim() || translate('archived'),
    }));
    head.appendChild(el('span', { class: 'np-archived-chip', text: translate('archived') }));
  } else {
    const title = el('input', {
      class: 'np-title-input',
      type: 'text',
      value: segment.title ?? '',
      maxlength: '200',
      placeholder: translate('titlePlaceholder'),
      'aria-label': translate('titlePlaceholder'),
      oninput: (event) => {
        segment.title = String(event.target.value ?? '');
        markDirty();
      },
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const textarea = card.querySelector('textarea');
          textarea?.focus();
        }
      },
    });
    head.appendChild(title);
  }

  const copy = el('button', {
    type: 'button',
    class: 'np-card-btn',
    title: translate('copy'),
    onclick: () => copyText(segmentContent(segment)),
  });
  copy.appendChild(ICONS.copy());
  head.appendChild(copy);

  if (archived) {
    const restore = el('button', {
      type: 'button',
      class: 'np-card-btn',
      title: translate('restore'),
      onclick: () => {
        segment.archived = false;
        segment.archivedAt = null;
        segment.origin = null;
        segment.__folded = false;
        markDirty();
        render();
        toast(translate('restoredToast'));
      },
    });
    restore.appendChild(ICONS.restore());
    head.appendChild(restore);
    const remove = el('button', {
      type: 'button',
      class: 'np-card-btn',
      'data-danger': 'true',
      title: translate('delete'),
      onclick: () => deleteSegment(segment),
    });
    remove.appendChild(ICONS.trash());
    head.appendChild(remove);
  } else {
    const improve = el('button', {
      type: 'button',
      class: 'np-card-btn',
      'data-ai': 'true',
      title: translate('optimize'),
      onclick: (event) => optimizeSegment(segment, event.currentTarget),
    });
    improve.appendChild(ICONS.sparkle());
    head.appendChild(improve);
    const archive = el('button', {
      type: 'button',
      class: 'np-card-btn',
      title: translate('archive'),
      onclick: () => {
        segment.archived = true;
        segment.archivedAt = new Date().toISOString();
        segment.origin = 'manual';
        markDirty();
        render();
        toast(translate('archivedToast'));
      },
    });
    archive.appendChild(ICONS.archive());
    head.appendChild(archive);
    const remove = el('button', {
      type: 'button',
      class: 'np-card-btn',
      'data-danger': 'true',
      title: translate('delete'),
      onclick: () => deleteSegment(segment),
    });
    remove.appendChild(ICONS.trash());
    head.appendChild(remove);
  }
  card.appendChild(head);

  const body = el('div', { class: 'np-card-body' });
  if (archived) {
    body.appendChild(el('div', { class: 'np-archived-preview', text: segment.text ?? '' }));
    if (!folded) body.appendChild(renderImages(segment));
  } else {
    const textarea = el('textarea', {
      class: 'np-textarea',
      placeholder: translate('placeholder'),
      spellcheck: 'false',
      'aria-label': translate('titlePlaceholder'),
      dataset: { id: segment.id },
    });
    textarea.value = segment.text ?? '';
    textarea.addEventListener('input', () => {
      segment.text = textarea.value;
      autoGrow(textarea);
      markDirty();
      updateFooter();
    });
    textarea.addEventListener('keydown', (event) => onTextareaKeyDown(event, segment, textarea));
    body.appendChild(textarea);
    requestAnimationFrame(() => autoGrow(textarea));
    body.appendChild(renderImages(segment));
  }
  card.appendChild(body);
  return card;
}

function renderImages(segment) {
  const wrap = el('div', { class: 'np-images' });
  for (const image of Array.isArray(segment.images) ? segment.images : []) {
    const button = el('button', {
      type: 'button',
      class: 'np-image',
      title: translate('preview'),
      onclick: () => {
        previewImage.src = imageUrl(image);
        previewImage.alt = image.name ?? '';
        previewNode.hidden = false;
      },
    });
    const img = el('img', { src: imageUrl(image), alt: image.name ?? '', loading: 'lazy' });
    img.addEventListener('error', () => {
      button.hidden = true;
    }, { once: true });
    button.appendChild(img);
    wrap.appendChild(button);
  }
  return wrap;
}

function onTextareaKeyDown(event, segment, textarea) {
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const start = Number(textarea.selectionStart) || 0;
    const end = Number(textarea.selectionEnd) || start;
    const before = String(segment.text ?? '').slice(0, start);
    const after = String(segment.text ?? '').slice(end);
    const index = segments.indexOf(segment);
    segment.text = before;
    const next = {
      id: newId(),
      text: after,
      title: '',
      createdAt: new Date().toISOString(),
      images: [],
      archived: false,
      archivedAt: null,
      origin: null,
    };
    segments.splice(index + 1, 0, next);
    markDirty();
    render();
    focusSegment(next.id, 'start');
    return;
  }
  if (event.key === 'Backspace' && String(segment.text ?? '') === '') {
    const active = allActive();
    if (active.length <= 1) return;
    const index = segments.indexOf(segment);
    if (index <= 0) return;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && segments[previousIndex].archived === true) previousIndex -= 1;
    if (previousIndex < 0) return;
    event.preventDefault();
    segments.splice(index, 1);
    const previous = segments[previousIndex];
    markDirty();
    render();
    focusSegment(previous.id, 'end');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveNow(true);
  }
}

function addSegment() {
  if (retired) return;
  const segment = {
    id: newId(),
    text: '',
    title: '',
    createdAt: new Date().toISOString(),
    images: [],
    archived: false,
    archivedAt: null,
    origin: null,
  };
  segments.push(segment);
  markDirty();
  render();
  focusSegment(segment.id, 'end');
}

function newId() {
  return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function deleteSegment(segment) {
  pendingDelete = segment.id;
  confirmTitle.textContent = translate('confirmTitle');
  confirmBody.textContent = translate('confirmBody');
  confirmCancel.textContent = translate('confirmCancel');
  confirmOk.textContent = translate('confirmOk');
  confirmNode.hidden = false;
}

function confirmDelete() {
  if (pendingDelete === '') return;
  segments = segments.filter((segment) => segment.id !== pendingDelete);
  pendingDelete = '';
  confirmNode.hidden = true;
  markDirty();
  render();
  toast(translate('deleted'));
}

async function optimizeSegment(segment, button) {
  if (retired) return;
  const text = String(segment.text ?? '');
  if (text.trim() === '') {
    toast(translate('optimizeEmpty'));
    return;
  }
  button.disabled = true;
  button.replaceChildren(el('span', { class: 'np-spinner' }));
  button.title = translate('optimizing');
  try {
    const data = await api('/optimize', { method: 'POST', body: { root: ROOT, text, title: segment.title ?? '' } });
    if (typeof data.text === 'string' && data.text.trim() !== '') {
      segment.text = data.text.trim();
      markDirty();
      render();
    } else {
      throw new Error(translate('optimizeFailed'));
    }
  } catch (error) {
    toast(String(error?.message || translate('optimizeFailed')));
    button.disabled = false;
    button.replaceChildren(ICONS.sparkle());
    button.title = translate('optimize');
    return;
  }
  button.disabled = false;
  button.replaceChildren(ICONS.sparkle());
  button.title = translate('optimize');
}

function markDirty() {
  dirty = true;
  revision += 1;
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    cacheTimer = 0;
    cacheNote();
  }, 800);
  if (retired) return;
  setStatus('dirty', translate('dirty'));
  if (config.saveMode === 'auto') scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    void saveNow(false);
  }, SAVE_DELAY);
}

function cacheNote() {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${ROOT}`, JSON.stringify({ at: Date.now(), segments }));
  } catch {
    /* Storage may be unavailable. */
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${ROOT}`);
    if (raw === null || raw === '') return null;
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || !Array.isArray(value.segments)) return null;
    return value.segments;
  } catch {
    return null;
  }
}

async function saveNow(force = false) {
  if (retired) return false;
  if (saving) {
    saveAgain = true;
    return false;
  }
  if (!dirty && force !== true) return false;
  const seq = ++saveSeq;
  const savedRevision = revision;
  saving = true;
  setStatus('saving', translate('saving'));
  const body = segments.map((segment) => ({
    id: segment.id,
    text: segment.text ?? '',
    title: segment.title ?? '',
    createdAt: segment.createdAt ?? null,
    images: Array.isArray(segment.images) ? segment.images : [],
    archived: segment.archived === true,
    archivedAt: segment.archivedAt ?? null,
    origin: segment.origin ?? null,
  }));
  try {
    const data = await api('/state', { method: 'PUT', body: { segments: body } });
    if (seq !== saveSeq) return false;
    dirty = revision !== savedRevision;
    online = true;
    lastSavedAt = typeof data.mtimeMs === 'number' ? data.mtimeMs : Date.now();
    setStatus('saved', `${translate('saved')} · ${clockLabel(lastSavedAt)}`);
    cacheNote();
    const [label, state] = statusLabel();
    setConnection(state, label);
    if (dirty) scheduleSave();
    return true;
  } catch (error) {
    dirty = true;
    if (!error?.status || error.status === 401 || error.status === 403 || error.status >= 500) {
      online = false;
      const [label, state] = statusLabel();
      setConnection(state, label);
    }
    setStatus('error', translate('saveFailed'));
    cacheNote();
    return false;
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      if (config.saveMode === 'auto') scheduleSave();
    }
  }
}

function clockLabel(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function copyText(value) {
  if (String(value ?? '') === '') return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      toast(translate('copied'));
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast(translate('copied'));
  } catch {
    toast(translate('copyFailed'));
  }
}

function showRetired() {
  retired = true;
  retiredNode.hidden = false;
  reattachButton.disabled = true;
  const [label, state] = statusLabel();
  setConnection(state, label);
  setStatus('error', translate('connRetired'));
}

async function retire() {
  if (retired) return;
  try {
    await api('/retire', { method: 'POST', body: { root: ROOT } });
  } catch {
    /* The window still closes/returns even when the host is unreachable. */
  }
  retired = true;
  try {
    window.opener?.postMessage({ type: 'dsh-notepad:reattached', root: ROOT }, '*');
  } catch {
    /* Cross-origin openers are allowed to ignore this. */
  }
  try {
    window.close();
  } catch {
    /* A browser tab opened by the OS may not be closable by script. */
  }
  showRetired();
}

async function heartbeat() {
  if (retired) return;
  try {
    const data = await api('/heartbeat', { method: 'POST', body: { root: ROOT } });
    online = true;
    if (data.retired === true) {
      showRetired();
      return;
    }
    const [label, state] = statusLabel();
    setConnection(state, label);
    if (dirty && config.saveMode === 'auto') scheduleSave();
  } catch {
    online = false;
    const [label, state] = statusLabel();
    setConnection(state, label);
  }
}

function flush() {
  if (!dirty || retired) return;
  cacheNote();
  try {
    const body = JSON.stringify({
      segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.text ?? '',
        title: segment.title ?? '',
        createdAt: segment.createdAt ?? null,
        images: Array.isArray(segment.images) ? segment.images : [],
        archived: segment.archived === true,
        archivedAt: segment.archivedAt ?? null,
        origin: segment.origin ?? null,
      })),
    });
    fetch(apiUrl('/state'), {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

async function load() {
  app.dataset.ready = 'false';
  setStatus('loading', translate('loading'));
  try {
    const note = await api('/state');
    try {
      const cfg = await api('/config');
      config = { ...config, ...cfg };
    } catch {
      /* The Host still delivers the note; use the inherited defaults. */
    }
    applyConfig();
    segments = Array.isArray(note.segments) ? note.segments : [];
    workspaceNode.textContent = note.title || baseName(ROOT);
    workspaceNode.title = ROOT;
    loaded = true;
    online = true;
    loadError = '';
    lastSavedAt = typeof note.mtimeMs === 'number' ? note.mtimeMs : null;
    setStatus(lastSavedAt === null ? 'saved' : 'saved', lastSavedAt === null ? translate('saved') : `${translate('saved')} · ${clockLabel(lastSavedAt)}`);
    const [label, state] = statusLabel();
    setConnection(state, label);
    render();
    document.title = `${translate('title')} · ${workspaceNode.textContent}`;
    // The DSH panel flushes its debounced save just before opening this
    // window. Re-read once after it has had time to land; skip the refresh as
    // soon as the user starts typing so a late response cannot overwrite it.
    setTimeout(async () => {
      if (!loaded || dirty === true || retired === true) return;
      try {
        const latest = await api('/state');
        if (dirty === true || !Array.isArray(latest.segments)) return;
        if (JSON.stringify(latest.segments) === JSON.stringify(segments)) return;
        segments = latest.segments;
        render();
      } catch {
        /* The first load already succeeded; this is only a race repair. */
      }
    }, 1200);
  } catch (error) {
    loaded = true;
    loadError = String(error?.message || translate('loadFailed'));
    online = false;
    const cached = readCache();
    if (cached !== null) {
      segments = cached;
      loadError = translate('offlineHint');
    }
    const [label, state] = statusLabel();
    setConnection(state, label);
    setStatus('error', translate('loadFailed'));
    render();
  }
}

function installEvents() {
  addButton.addEventListener('click', addSegment);
  saveButton.addEventListener('click', () => void saveNow(true));
  copyAllButton.addEventListener('click', () => {
    const text = allActive().map(segmentContent).filter((value) => value.trim() !== '').join('\n\n');
    void copyText(text);
  });
  archiveButton.addEventListener('click', () => {
    const active = archiveButton.dataset.active === 'true' ? 'false' : 'true';
    archiveButton.dataset.active = active;
    archiveButton.setAttribute('aria-pressed', active === 'true' ? 'true' : 'false');
    archiveButton.title = translate('archiveTitle');
    render();
  });
  reattachButton.addEventListener('click', () => void retire());
  confirmCancel.addEventListener('click', () => {
    pendingDelete = '';
    confirmNode.hidden = true;
  });
  confirmOk.addEventListener('click', confirmDelete);
  confirmNode.addEventListener('click', (event) => {
    if (event.target === confirmNode) {
      pendingDelete = '';
      confirmNode.hidden = true;
    }
  });
  previewClose.addEventListener('click', () => {
    previewNode.hidden = true;
    previewImage.src = '';
  });
  previewNode.addEventListener('click', (event) => {
    if (event.target === previewNode) {
      previewNode.hidden = true;
      previewImage.src = '';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      pendingDelete = '';
      confirmNode.hidden = true;
      previewNode.hidden = true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveNow(true);
    }
  });
  window.addEventListener('pagehide', () => {
    flush();
    try {
      navigator.sendBeacon(apiUrl('/bye'), new Blob([JSON.stringify({ root: ROOT })], { type: 'application/json' }));
    } catch {
      /* ignore */
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('online', () => {
    online = true;
    void heartbeat();
    if (dirty) scheduleSave();
  });
}

async function boot() {
  installEvents();
  applyConfig();
  await load();
  heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  void heartbeat();
}

void boot();
