import { $, fmtSize, toast } from './utils.js';

const overlay = $('#fe-overlay');

let rootHandle = null;
let path = [];
let selected = new Map();
let onPick = null;
const sizeCache = new Map();

function currentHandle() {
  return path.length ? path[path.length - 1].handle : rootHandle;
}

function keyFor(name) {
  return path.map((d) => d.name).concat(name).join('/');
}

function setSize(el, n) {
  el.textContent = fmtSize(n);
}

function updateCount() {
  const countEl = $('#fe-count');
  const send = $('#fe-send');
  const n = selected.size;
  if (countEl) countEl.textContent = n ? `${n} selected` : 'Nothing selected';
  if (send) send.disabled = n === 0;
}

async function render() {
  const list = $('#fe-list');
  const crumbs = $('#fe-crumbs');
  const dir = currentHandle();
  if (!list || !crumbs || !dir) return;

  crumbs.innerHTML = '';
  const rootCrumb = document.createElement('button');
  rootCrumb.className = 'fe-crumb';
  rootCrumb.textContent = rootHandle.name;
  rootCrumb.addEventListener('click', () => {
    path = [];
    render();
  });
  crumbs.appendChild(rootCrumb);

  path.forEach((d, i) => {
    const sep = document.createElement('span');
    sep.className = 'fe-crumb-sep';
    sep.textContent = '/';
    const crumb = document.createElement('button');
    crumb.className = 'fe-crumb fe-crumb-active';
    crumb.textContent = d.name;
    const idx = i;
    crumb.addEventListener('click', () => {
      path = path.slice(0, idx);
      render();
    });
    crumbs.appendChild(sep);
    crumbs.appendChild(crumb);
  });

  list.innerHTML = '';
  if (path.length) {
    const up = document.createElement('div');
    up.className = 'fe-row fe-up';
    up.innerHTML = '<span class="fe-ico">⬆</span><span class="fe-name">Up</span>';
    up.addEventListener('click', () => {
      path.pop();
      render();
    });
    list.appendChild(up);
  }

  const entries = [];
  try {
    for await (const [name, handle] of dir.entries()) entries.push({ name, handle });
  } catch {
    close();
    toast('Could not read this folder.', 'error');
    return;
  }
  entries.sort((a, b) =>
    a.handle.kind === b.handle.kind
      ? a.name.localeCompare(b.name)
      : a.handle.kind === 'directory'
        ? -1
        : 1
  );

  for (const { name, handle } of entries) {
    const isDir = handle.kind === 'directory';
    const key = keyFor(name);
    const row = document.createElement('div');
    row.className = 'fe-row' + (selected.has(key) ? ' fe-sel' : '');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'fe-chk';
    chk.checked = selected.has(key);
    chk.addEventListener('change', () => {
      if (chk.checked) selected.set(key, { handle, isDir });
      else selected.delete(key);
      row.classList.toggle('fe-sel', chk.checked);
      updateCount();
    });
    const icon = document.createElement('span');
    icon.className = 'fe-ico';
    icon.textContent = isDir ? '📁' : '📄';
    const nameEl = document.createElement('span');
    nameEl.className = 'fe-name';
    nameEl.textContent = name;
    nameEl.title = name;
    row.appendChild(chk);
    row.appendChild(icon);
    row.appendChild(nameEl);
    if (!isDir) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'fe-size';
      row.appendChild(sizeEl);
      if (sizeCache.has(key)) setSize(sizeEl, sizeCache.get(key));
      else
        handle
          .getFile()
          .then((f) => {
            sizeCache.set(key, f.size);
            setSize(sizeEl, f.size);
          })
          .catch(() => {});
    }
    row.addEventListener('click', (e) => {
      if (e.target === chk) return;
      if (isDir) {
        path.push({ name, handle });
        render();
        return;
      }
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
    });
    list.appendChild(row);
  }
  updateCount();
}

async function gatherDir(handle, prefix) {
  const out = [];
  for await (const [name, h] of handle.entries()) {
    if (h.kind === 'file') {
      const file = await h.getFile();
      file.relativePath = prefix ? prefix + '/' + name : name;
      out.push(file);
    } else {
      out.push(...(await gatherDir(h, prefix ? prefix + '/' + name : name)));
    }
  }
  return out;
}

async function send() {
  const btn = $('#fe-send');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  const files = [];
  let empty = false;
  for (const { handle, isDir } of selected.values()) {
    if (!isDir) {
      files.push(await handle.getFile());
    } else {
      const got = await gatherDir(handle, handle.name);
      if (!got.length) empty = true;
      files.push(...got);
    }
  }
  close();
  if (empty) toast('One of the selected folders is empty.', 'error');
  if (onPick && files.length) onPick(files);
}

function close() {
  overlay.classList.add('hidden');
  const send = $('#fe-send');
  if (send) {
    send.disabled = true;
    send.textContent = 'Send';
  }
}

export function openFileExplorer(pick) {
  onPick = pick;
  if (!window.showDirectoryPicker) return false;
  return (async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      rootHandle = handle;
      path = [];
      selected.clear();
      sizeCache.clear();
      overlay.classList.remove('hidden');
      const send = $('#fe-send');
      if (send) send.disabled = true;
      await render();
      return true;
    } catch (err) {
      if (err && err.name === 'SecurityError') return false;
      return true;
    }
  })();
}

$('#fe-close')?.addEventListener('click', close);
$('#fe-clear')?.addEventListener('click', () => {
  selected.clear();
  render();
  updateCount();
});
$('#fe-send')?.addEventListener('click', send);
$('#fe-overlay')?.addEventListener('click', (e) => {
  if (e.target === $('#fe-overlay')) close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) close();
});