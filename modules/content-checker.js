// ShareWeb Client-Side Sensitive Content Scanner (NSFWJS ML Model)
import { $, toast } from './utils.js';
import { t } from './i18n.js';

export const MOD = (() => {
  const THRESHOLD = 0.65;
  const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
  const VIDEO_TYPES = /^video\/(mp4|webm|ogg|quicktime|x-matroska|3gpp|x-msvideo)$/i;
  const MAX_DIM = 256;
  const VIDEO_FRAMES = 8;

  let modelPromise = null;

  function loadModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        if (!window.tf || !window.nsfwjs) throw new Error('checker unavailable');
        try {
          await tf.setBackend('webgl');
        } catch {
          await tf.setBackend('cpu');
        }
        await tf.ready();
        return nsfwjs.load('/vendor/nsfw-model/model.json', { type: 'graph' });
      })().catch((err) => {
        modelPromise = null;
        throw err;
      });
    }
    return modelPromise;
  }

  function scoreOf(preds) {
    const by = {};
    for (const p of preds || []) by[p.className] = p.probability;
    const porn = by.Porn || 0;
    const hentai = by.Hentai || 0;
    const score = Math.max(porn, hentai);
    return { porn, hentai, score, block: score >= THRESHOLD };
  }

  function drawScaled(img, w, h) {
    const scale = Math.min(1, MAX_DIM / Math.max(w, h, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function classifyImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('image'));
        i.src = url;
      });
      return scoreOf(await (await loadModel()).classify(drawScaled(img, img.naturalWidth || img.width, img.naturalHeight || img.height)));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function classifyVideo(blob) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(), 8000);
        video.onloadedmetadata = () => {
          clearTimeout(t);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(t);
          reject(new Error('video'));
        };
      });
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const model = await loadModel();
      let worst = null;
      for (let i = 1; i <= VIDEO_FRAMES; i++) {
        const t = dur > 0 ? (dur * i) / (VIDEO_FRAMES + 1) : 0;
        video.currentTime = t;
        await new Promise((resolve) => {
          const done = () => {
            video.removeEventListener('seeked', done);
            resolve();
          };
          video.addEventListener('seeked', done);
          setTimeout(done, 4000);
        });
        const w = video.videoWidth || MAX_DIM;
        const h = video.videoHeight || MAX_DIM;
        const r = scoreOf(await model.classify(drawScaled(video, w, h)));
        if (!worst || r.score > worst.score) worst = r;
        if (worst.block) break;
      }
      return worst || { porn: 0, hentai: 0, score: 0, block: false };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function isScannable(mime) {
    return IMAGE_TYPES.test(mime || '') || VIDEO_TYPES.test(mime || '');
  }

  async function checkFile(file) {
    if (!isScannable(file.type)) return null;
    return IMAGE_TYPES.test(file.type) ? classifyImage(file) : classifyVideo(file);
  }

  return { loadModel, isScannable, checkFile };
})();

async function traverseEntry(entry, pathPrefix = '') {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (file) => {
          const fullPath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
          try {
            Object.defineProperty(file, 'relativePath', {
              value: fullPath,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          } catch {
            file.relativePath = fullPath;
          }
          resolve([file]);
        },
        () => resolve([])
      );
    });
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const newPrefix = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    const subFiles = [];
    const readBatch = () =>
      new Promise((resolve) => {
        dirReader.readEntries(
          async (entries) => {
            if (!entries || entries.length === 0) {
              resolve(subFiles);
            } else {
              for (const child of entries) {
                const res = await traverseEntry(child, newPrefix);
                subFiles.push(...res);
              }
              resolve(await readBatch());
            }
          },
          () => resolve(subFiles)
        );
      });
    return await readBatch();
  }
  return [];
}

async function extractFilesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  try {
    const items = dataTransfer.items;
    if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
      const entryPromises = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
          if (entry) {
            entryPromises.push(traverseEntry(entry));
          }
        }
      }
      if (entryPromises.length > 0) {
        const nestedLists = await Promise.all(entryPromises);
        const flattened = nestedLists.flat();
        if (flattened.length > 0) return flattened;
      }
    }
  } catch (err) {
    console.warn('Folder traversal fallback to standard files:', err);
  }
  return Array.from(dataTransfer.files || []);
}

