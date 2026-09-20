// ShareWeb QR Code Generator & Modal Integration
(function() {
  window.ShareWebQR = {
    async getSVG(text, options = {}) {
      const dark = options.dark || '#0f172a';
      const light = options.light || '#ffffff';
      const url = `/api/qr?text=${encodeURIComponent(text)}&dark=${encodeURIComponent(dark)}&light=${encodeURIComponent(light)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to generate QR code');
      return await res.text();
    },

    async showModal(title, textToEncode, displayLink) {
      const modal = document.getElementById('modal-qr');
      if (!modal) return;
      const titleEl = document.getElementById('qr-modal-title');
      const container = document.getElementById('qr-code-container');
      const input = document.getElementById('qr-link-input');
      if (titleEl) titleEl.textContent = title || 'Scan to Connect';
      if (input) input.value = displayLink || textToEncode;
      if (container) {
        container.innerHTML = '<div class="loader-spinner" style="margin:40px auto;"></div>';
        try {
          const svg = await this.getSVG(textToEncode);
          container.innerHTML = svg;
          const svgEl = container.querySelector('svg');
          if (svgEl) {
            svgEl.style.width = '100%';
            svgEl.style.height = '100%';
            svgEl.style.borderRadius = '12px';
            svgEl.style.display = 'block';
          }
        } catch (err) {
          container.innerHTML = `<p class="ea-error" style="padding:20px;">Failed to generate QR code: ${err.message}</p>`;
        }
      }
      modal.classList.remove('hidden');
    },

    hideModal() {
      const modal = document.getElementById('modal-qr');
      if (modal) modal.classList.add('hidden');
    }
  };
})();
