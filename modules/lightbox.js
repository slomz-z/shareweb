// ShareWeb QuickLook & Media Lightbox Preview Modal
import { $, esc, fmtSize, resType } from './utils.js';
import { t } from './i18n.js';

let currentQlObjectUrl = null;
let currentQlBlob = null;
let currentQlUrl = null;
let currentQlFilename = '';

export 
async function openQuickLook({ blob, url, filename, mime, size }) {
  const modal = $('#modal-quicklook');
  if (!modal) return;

  if (currentQlObjectUrl) {
    try { URL.revokeObjectURL(currentQlObjectUrl); } catch {}
    currentQlObjectUrl = null;
  }
  currentQlBlob = blob || null;
  currentQlUrl = url || null;
  currentQlFilename = filename || 'file';

  const ext = (filename.split('.').pop() || '').toLowerCase();
  const detectedMime = mime || resType(filename) || 'application/octet-stream';
  const displaySize = fmtSize(size || (blob ? blob.size : 0));

  const filenameEl = $('#ql-filename');
  const filesizeEl = $('#ql-filesize');
  const badgeEl = $('#ql-badge');
  const viewport = $('#ql-viewport');
  const copyBtn = $('#ql-copy-btn');

  if (filenameEl) filenameEl.textContent = filename;
  if (filesizeEl) filesizeEl.textContent = displaySize;
  if (badgeEl) badgeEl.textContent = (ext || 'file').toUpperCase();
  if (copyBtn) copyBtn.classList.add('hidden');

  if (viewport) {
    viewport.innerHTML = '<div class="loader-spinner" style="margin:40px auto;"></div>';
  }
  modal.classList.remove('hidden');

  const fileUrl = blob ? (currentQlObjectUrl = URL.createObjectURL(blob)) : url;

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'weba'];
  const videoExts = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
  const codeExts = ['txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'css', 'py', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'xml', 'sql', 'log', 'csv', 'ini', 'env', 'conf'];

  try {
    if (imageExts.includes(ext) || detectedMime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = fileUrl;
      img.alt = filename;
      img.onload = () => {
        if (viewport) {
          viewport.innerHTML = '';
          viewport.appendChild(img);
        }
      };
      img.onerror = () => {
        renderBinaryInspector(filename, displaySize, ext, detectedMime, blob, url);
      };
    } else if (audioExts.includes(ext) || detectedMime.startsWith('audio/')) {
      if (viewport) {
        viewport.innerHTML = `
          <div style="display:flex; flex-direction:column; align-items:center; gap:20px; width:100%; max-width:480px; padding:20px;">
            <div class="ql-inspector-icon" style="font-size:36px; width:80px; height:80px;">🎵</div>
            <audio controls autoplay style="width:100%;">
              <source src="${fileUrl}" type="${detectedMime}">
              Your browser does not support audio preview.
            </audio>
          </div>`;
      }
    } else if (videoExts.includes(ext) || detectedMime.startsWith('video/')) {
      if (viewport) {
        viewport.innerHTML = `
          <video controls autoplay playsinline style="max-width:100%; max-height:70vh; border-radius:12px; outline:none; box-shadow:0 8px 24px rgba(0,0,0,0.25);">
            <source src="${fileUrl}" type="${detectedMime}">
            Your browser does not support video preview.
          </video>`;
      }
    } else if (ext === 'pdf' || detectedMime === 'application/pdf') {
      if (viewport) {
        viewport.innerHTML = `<iframe src="${fileUrl}#view=FitH" style="width:100%; height:70vh; border:none; border-radius:12px; background:#fff;"></iframe>`;
      }
    } else if (codeExts.includes(ext) || detectedMime.startsWith('text/') || detectedMime === 'application/json') {
      let textContent = '';
      if (blob) {
        textContent = await blob.text();
      } else {
        const res = await fetch(url);
        textContent = await res.text();
      }
      if (viewport) {
        viewport.innerHTML = `<pre class="ql-code-wrap"><code>${esc(textContent.slice(0, 100000))}${textContent.length > 100000 ? '\n\n... (truncated for preview)' : ''}</code></pre>`;
      }
      if (copyBtn) {
        copyBtn.classList.remove('hidden');
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(textContent);
            toast(t('copied', 'Copied to clipboard'), 'success');
          } catch {
            toast(t('copyFailed', 'Could not copy content'), 'error');
          }
        };
      }
    } else {
      await renderBinaryInspector(filename, displaySize, ext, detectedMime, blob, url);
    }
  } catch (err) {
    console.error('QuickLook rendering error:', err);
    await renderBinaryInspector(filename, displaySize, ext, detectedMime, blob, url);
  }
}

async function renderBinaryInspector(filename, displaySize, ext, mime, blob, url) {
  const viewport = $('#ql-viewport');
  if (!viewport) return;
  let hexDump = '';
  try {
    let bytes = null;
    if (blob) {
      const slice = blob.slice(0, 64);
      bytes = new Uint8Array(await slice.arrayBuffer());
    } else if (url) {
      const res = await fetch(url, { headers: { Range: 'bytes=0-63' } });
      if (res.ok) {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
    }
    if (bytes && bytes.length > 0) {
      const lines = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.subarray(i, i + 16);
        const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(chunk).map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
        const offset = i.toString(16).padStart(4, '0');
        lines.push(`${offset}  ${hex.padEnd(48, ' ')}  |${ascii}|`);
      }
      hexDump = lines.join('\n');
    }
  } catch {}

  let icon = '📁';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) icon = '📦';
  else if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) icon = '📝';
  else if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) icon = '📊';
  else if (['ppt', 'pptx', 'key'].includes(ext)) icon = '📽️';
  else if (['apk', 'ipa', 'exe', 'dmg', 'iso', 'bin', 'app'].includes(ext)) icon = '⚙️';
  else if (['font', 'ttf', 'otf', 'woff', 'woff2'].includes(ext)) icon = '🔤';

  viewport.innerHTML = `
    <div class="ql-inspector-card">
      <div class="ql-inspector-icon">${icon}</div>
      <div style="font-weight:700; font-size:16px; word-break:break-word; color:var(--text);">${esc(filename)}</div>
      <div class="ql-inspector-meta">
        <div class="ql-meta-row"><span>Type</span><span>${esc((ext || 'Binary').toUpperCase())} (${esc(mime)})</span></div>
        <div class="ql-meta-row"><span>Size</span><span>${esc(displaySize)}</span></div>
        <div class="ql-meta-row"><span>Format</span><span>${ext ? `.${ext.toUpperCase()} File` : 'Raw Data'}</span></div>
      </div>
      ${hexDump ? `
        <div style="width:100%; text-align:left; margin-top:8px;">
          <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:var(--text-soft); margin-bottom:6px; letter-spacing:0.5px;">Hex / Magic Bytes</div>
          <pre class="ql-code-wrap" style="max-height:140px; font-size:11px; padding:10px; margin:0; line-height:1.4;"><code>${esc(hexDump)}</code></pre>
        </div>` : ''}
    </div>`;
}

export function closeQuickLook() {
  const modal = $('#modal-quicklook');
  if (modal) modal.classList.add('hidden');
  const viewport = $('#ql-viewport');
  if (viewport) viewport.innerHTML = '';
  if (currentQlObjectUrl) {
    try { URL.revokeObjectURL(currentQlObjectUrl); } catch {}
    currentQlObjectUrl = null;
  }
}

export function initQuickLook() {
  $('#ql-close-btn')?.addEventListener('click', closeQuickLook);
  $('#modal-quicklook')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-quicklook' || e.target.classList.contains('ql-backdrop')) {
      closeQuickLook();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const ql = $('#modal-quicklook');
      if (ql && !ql.classList.contains('hidden')) {
        closeQuickLook();
      }
    }
  });

  $('#ql-download-btn')?.addEventListener('click', () => {
    if (currentQlBlob) {
      const a = document.createElement('a');
      a.href = currentQlObjectUrl;
      a.download = currentQlFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else if (currentQlUrl) {
      const a = document.createElement('a');
      a.href = currentQlUrl;
      a.download = currentQlFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });
}
