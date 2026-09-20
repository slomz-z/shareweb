// ShareWeb File & Folder Selection, Drag-and-Drop & Glassmorphism Overlay
import { state } from './state.js';
import { $, esc, fmtSize, toast } from './utils.js';
import { t } from './i18n.js';
import { MOD } from './content-checker.js';
import { addTransferCard, setCardStatus } from './transfer-cards.js';
import { openQuickLook } from './lightbox.js';
import { zipFolderFiles } from './zip.js';
import { openFileExplorer } from './file-explorer.js';

async function scanFiles(items) {
  if (!items || items.length === 0) return items;
  for (const item of items) {
    const f = item.file || item;
    if (!f || !f.type) continue;
    if (f.type.startsWith('image/') || f.type.startsWith('video/')) {
      state.scanning.add(item.id || f.name);
      MOD.scan(f).then(isBlocked => {
        state.scanning.delete(item.id || f.name);
        if (isBlocked) {
          state.files = state.files.filter(x => (x.id || x.name) !== (item.id || f.name));
          state.blockedCount++;
          toast(t('sensitiveContentBlocked', 'File blocked due to sensitive content.'), 'error');
          renderPicked();
        }
      }).catch(() => {
        state.scanning.delete(item.id || f.name);
      });
    }
  }
  return items;
}

export async function addFiles(fileList) {
  const list = Array.from(fileList || []);
  const folderItems = [];
  const plainItems = [];
  for (const f of list) {
    const p = f && (f.relativePath || f.name);
    if (p && String(p).includes('/')) folderItems.push(f);
    else if (f) plainItems.push(f);
  }
  const added = [];
  const push = (f) => {
    const fKey = f.relativePath || f.name;
    if (state.files.some((x) => (x.relativePath || x.name) === fKey && x.size === f.size && x.lastModified === f.lastModified)) return;
    state.files.push(f);
    added.push(f);
  };
  plainItems.forEach(push);
  const groups = new Map();
  for (const f of folderItems) {
    const root = String(f.relativePath).split('/')[0];
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  for (const group of groups.values()) {
    const zip = await zipFolderFiles(group);
    if (zip) push(zip);
  }
  renderPicked();
  if (added.length) scanAddedFiles(added);
}

async function scanAddedFiles(files) {
  for (const f of files) {
    if (!MOD.isScannable(f.type)) continue;
    state.scanning.add(f);
    renderPicked();
    try {
      const r = await MOD.checkFile(f);
      if (r && r.block) {
        state.files = state.files.filter((x) => x !== f);
        state.blockedCount += 1;
      }
    } catch {
      /* checker unavailable: allow the file through */
    } finally {
      state.scanning.delete(f);
    }
  }
  renderPicked();
  if (state.blockedCount > 0) {
    const n = state.blockedCount;
    state.blockedCount = 0;
    fetch('/api/moderation/report', { method: 'POST' }).catch(() => {});
    toast(
      `<b>${n === 1 ? 'A file was' : n + ' files were'}</b> blocked because it may contain sensitive content. ` +
        `Uploads from this device are paused for 5 minutes.`,
      'error',
      6000
    );
  }
}

export function renderPicked() {
  const wrap = $('#file-picker-wrap');
  if (wrap) wrap.classList.toggle('hidden', state.files.length === 0);
  const ul = $('#picked-files');
  if (!ul) return;
  ul.innerHTML = '';
  state.files.forEach((f, i) => {
    const displayName = f.relativePath || f.name;
    const isFolderFile = !!(f.relativePath && f.relativePath.includes('/'));
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="fname" title="${esc(displayName)}">
        ${isFolderFile ? '<span class="folder-badge">📁</span>' : ''}
        ${isFolderFile ? `<span class="tree-path">${esc(displayName.slice(0, displayName.lastIndexOf('/') + 1))}</span>` : ''}
        ${esc(isFolderFile ? displayName.slice(displayName.lastIndexOf('/') + 1) : displayName)}
      </span>
      <span class="fsize">${fmtSize(f.size)}</span>
      <button class="h-preview-btn picked-preview" title="${esc(t('quicklook', 'QuickLook'))}" aria-label="Preview" style="margin-right:4px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button class="x" title="${esc(t('remove', 'Remove'))}">✕</button>`;
    li.querySelector('.picked-preview')?.addEventListener('click', () => {
      openQuickLook({ blob: f, filename: displayName, size: f.size, mime: f.type });
    });
    li.querySelector('.x').addEventListener('click', () => {
      state.files.splice(i, 1);
      renderPicked();
    });
    ul.appendChild(li);
  });
  const sendBtn = $('#send-btn');
  if (sendBtn) {
    sendBtn.disabled = state.files.length === 0 || !state.selected || state.scanning.size > 0;
    sendBtn.textContent = (state.selected && state.selected.isRoomBroadcast) ? t('sendToAll', 'Send to all') : t('send', 'Send');
  }
}

$('#file-input')?.addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#folder-input')?.addEventListener('change', (e) => {
  const fileList = Array.from(e.target.files || []).map((f) => {
    if (f.webkitRelativePath) {
      try {
        Object.defineProperty(f, 'relativePath', {
          value: f.webkitRelativePath,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {
        f.relativePath = f.webkitRelativePath;
      }
    }
    return f;
  });
  addFiles(fileList);
  e.target.value = '';
});
$('#clear-btn')?.addEventListener('click', () => {
  state.files = [];
  renderPicked();
});

export async function extractFilesFromDataTransfer(dt) {
  const files = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (typeof item.webkitGetAsEntry === 'function') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          await traverseEntry(entry, '', files);
          continue;
        }
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      files.push(dt.files[i]);
    }
  }
  return files;
}

async function traverseEntry(entry, pathSoFar, filesList) {
  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve));
    if (file) {
      file.relativePath = pathSoFar ? (pathSoFar + '/' + file.name) : file.name;
      filesList.push(file);
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const readEntries = async () => {
      const entries = await new Promise((resolve) => reader.readEntries(resolve));
      if (entries.length > 0) {
        for (const child of entries) {
          await traverseEntry(child, pathSoFar ? (pathSoFar + '/' + entry.name) : entry.name, filesList);
        }
        await readEntries();
      }
    };
    await readEntries();
  }
}

export function initFilePicker() {
  const fileInput = $('#file-input');
  fileInput?.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      addFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  const folderInput = $('#folder-input');
  folderInput?.addEventListener('change', () => {
    if (folderInput.files.length > 0) {
      addFiles(folderInput.files);
      folderInput.value = '';
    }
  });

  $('#dz-browse-text')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const handled = await openFileExplorer(addFiles);
    if (handled === false) {
      const modal = $('#fp-fallback-modal');
      if (modal) modal.classList.remove('hidden');
      else $('#file-input')?.click();
    }
  });

  const fallbackModal = $('#fp-fallback-modal');
  const hideFallback = () => fallbackModal?.classList.add('hidden');
  $('#fp-files')?.addEventListener('click', () => {
    hideFallback();
    $('#file-input')?.click();
  });
  $('#fp-folder')?.addEventListener('click', () => {
    hideFallback();
    $('#folder-input')?.click();
  });
  $('#fp-close')?.addEventListener('click', hideFallback);
  fallbackModal?.addEventListener('click', (e) => {
    if (e.target === fallbackModal) hideFallback();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fallbackModal && !fallbackModal.classList.contains('hidden')) hideFallback();
  });

  const dz = $('#dropzone');
  if (dz) {
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag-over');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const files = await extractFilesFromDataTransfer(e.dataTransfer);
      if (files.length > 0) addFiles(files);
    });
  }

  // Global Drag & Drop Overlay
  const overlay = document.getElementById('global-drag-overlay');
  if (overlay) {
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        overlay.classList.add('active');
      }
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlay.classList.remove('active');
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.remove('active');
      if (e.dataTransfer) {
        const files = await extractFilesFromDataTransfer(e.dataTransfer);
        if (files.length > 0) {
          addFiles(files);
          window.ShareWebSound?.triggerHaptic([20]);
        }
      }
    });
  }
}
