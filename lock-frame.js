/**
 * ShareWeb Lock Frame Engine
 * Prevents zooming (keyboard, mouse wheel, trackpad pinch, mobile touch pinch, double tap)
 * and locks the layout frame inside the viewport across PCs and phones.
 */
(function lockAppFrame() {
  'use strict';

  // 0. Ensure the app is accessed exclusively through the official main domain
  try {
    var hostname = window.location.hostname;
    var isLocalOrTunnel = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.indexOf('trycloudflare.com') !== -1;
    if (window.self === window.top && isLocalOrTunnel) {
      window.location.replace('https://shareweb.slomz.is-a.dev' + window.location.pathname + window.location.search + window.location.hash);
      return;
    }
  } catch (_) {}

  // 1. Prevent PC Ctrl/Cmd + Mouse Wheel / Trackpad pinch-to-zoom
  window.addEventListener(
    'wheel',
    function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // 2. Prevent PC Keyboard Zoom shortcuts (Ctrl/Cmd + '+', '-', '0', '=')
  window.addEventListener(
    'keydown',
    function (e) {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === '+' ||
          e.key === '-' ||
          e.key === '=' ||
          e.key === '_' ||
          e.key === '0' ||
          e.keyCode === 187 ||
          e.keyCode === 189 ||
          e.keyCode === 48 ||
          e.keyCode === 96 ||
          e.keyCode === 107 ||
          e.keyCode === 109)
      ) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // 3. Prevent Multi-touch Pinch Zoom on Mobile & Touchscreens
  document.addEventListener(
    'touchstart',
    function (e) {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener(
    'touchmove',
    function (e) {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // 4. Prevent Safari / WebKit Gesture Events (pinch/rotation zoom)
  document.addEventListener(
    'gesturestart',
    function (e) {
      e.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener(
    'gesturechange',
    function (e) {
      e.preventDefault();
    },
    { passive: false }
  );

  document.addEventListener(
    'gestureend',
    function (e) {
      e.preventDefault();
    },
    { passive: false }
  );

  // 5. Prevent Fast Double-Tap Zoom on Mobile (excluding editable form fields)
  var lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    function (e) {
      var now = Date.now();
      if (now - lastTouchEnd <= 300) {
        var target = e.target;
        var isInteractive =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable);
        if (!isInteractive) {
          e.preventDefault();
        }
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );

  // 6. Prevent Dragging Files or Content Outside Frame from navigating browser away
  window.addEventListener(
    'dragover',
    function (e) {
      if (!e.target || !e.target.closest('#dropzone, .dropzone, [data-dropzone]')) {
        e.preventDefault();
      }
    },
    false
  );

  window.addEventListener(
    'drop',
    function (e) {
      if (!e.target || !e.target.closest('#dropzone, .dropzone, [data-dropzone]')) {
        e.preventDefault();
      }
    },
    false
  );

  // 7. Dynamic Viewport enforcement & visualViewport scaling reset
  function enforceViewport() {
    var meta = document.querySelector('meta[name="viewport"]');
    var content =
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    if (meta.content !== content) {
      meta.content = content;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enforceViewport);
  } else {
    enforceViewport();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      if (window.visualViewport.scale !== 1) {
        enforceViewport();
      }
    });
  }
})();
