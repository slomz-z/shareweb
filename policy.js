const backBtn = document.getElementById('policy-back');
if (backBtn) {
  if (document.referrer && new URL(document.referrer, location.href).origin === location.origin) {
    backBtn.href = document.referrer;
  }
  backBtn.addEventListener('click', (e) => {
    if (document.referrer && new URL(document.referrer, location.href).origin === location.origin) {
      e.preventDefault();
      history.back();
    }
  });
}

if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
  window.ShareWebLoader.whenReady({
    waitForFonts: true,
    waitForLanguage: true,
    images: Array.from(document.images || [])
  });
} else if (window.hidePageLoader) {
  window.hidePageLoader();
}
