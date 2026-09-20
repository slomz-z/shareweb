// ShareWeb Smooth Gliding Caret Animation
export function initGlidingCaret() {
  if (typeof HTMLInputElement === 'undefined' || !('selectionStart' in HTMLInputElement.prototype)) return;
  const PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform', 'textAlign', 'lineHeight', 'paddingLeft', 'paddingRight', 'boxSizing', 'direction'];
  const inputs = new Set();
  let mirror = null;

  function measure(input) {
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.className = 'caret-mirror';
      document.body.appendChild(mirror);
    }
    const cs = getComputedStyle(input);
    for (const p of PROPS) mirror.style[p] = cs[p] || '';
    mirror.style.width = input.clientWidth + 'px';
    mirror.textContent = '';
    const pre = document.createElement('span');
    pre.style.whiteSpace = 'pre';
    pre.textContent =
      input.type === 'password'
        ? (input.value || '').slice(0, input.selectionStart).replace(/./g, '•')
        : (input.value || '').slice(0, input.selectionStart);
    const marker = document.createElement('span');
    marker.style.display = 'inline-block';
    marker.style.width = '0';
    pre.appendChild(marker);
    mirror.appendChild(pre);
    const ir = input.getBoundingClientRect();
    mirror.style.left = ir.left + 'px';
    mirror.style.top = ir.top + 'px';
    const x = marker.getBoundingClientRect().left - (input.scrollLeft || 0);
    return { x, top: ir.top, h: ir.height };
  }

  function refresh(input) {
    if (document.activeElement !== input) {
      input.classList.remove('no-native-caret');
      const c = input._caret;
      if (c) c.classList.remove('active');
      return;
    }
    const s = input.selectionStart;
    const e = input.selectionEnd;
    if (s == null || s !== e || !input.clientWidth) {
      input.classList.remove('no-native-caret');
      const c = input._caret;
      if (c) c.classList.remove('active');
      return;
    }
    let pos;
    try {
      pos = measure(input);
    } catch {
      return;
    }
    if (!isFinite(pos.x)) return;
    let c = input._caret;
    if (!c) {
      c = document.createElement('div');
      c.className = 'caret-glow';
      document.body.appendChild(c);
      input._caret = c;
    }
    input.classList.add('no-native-caret');
    c.classList.add('active');
    const h = Math.max(14, Math.min(22, pos.h - 16));
    c.style.top = (pos.top + (pos.h - h) / 2) + 'px';
    c.style.height = h + 'px';
    c.style.transform = 'translateX(' + Math.round(pos.x) + 'px)';
  }

  for (const input of document.querySelectorAll('input[type=text], input[type=email], input[type=password], input[type=search]')) {
    if (input.disabled || input.readOnly) continue;
    inputs.add(input);
    input.addEventListener('focus', () => refresh(input));
    input.addEventListener('blur', () => refresh(input));
    input.addEventListener('click', () => refresh(input));
    input.addEventListener('keyup', () => refresh(input));
    input.addEventListener('input', () => refresh(input));
    input.addEventListener('scroll', () => refresh(input), true);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => inputs.forEach(refresh));
  window.addEventListener('resize', () => inputs.forEach(refresh));
}
