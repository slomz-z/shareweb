/* Account Management Client Logic */

(function () {
  'use strict';

  // Theme Sync
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  // State
  const state = {
    user: null,
    changeEmailToken: null,
    deleteAccountToken: null,
  };

  // DOM Elements
  const el = {
    loader: document.getElementById('global-page-loader'),
    avatar: document.getElementById('user-avatar'),
    displayName: document.getElementById('user-display-name'),
    displayEmail: document.getElementById('user-display-email'),
    authBadge: document.getElementById('user-auth-badge'),
    
    // Change Email
    formReqEmail: document.getElementById('form-request-email-change'),
    pwEmailReq: document.getElementById('email-change-pw'),
    newEmailInput: document.getElementById('email-change-new'),
    btnReqEmail: document.getElementById('btn-request-email-code'),
    reqEmailFeedback: document.getElementById('email-change-request-feedback'),
    
    formConfirmEmail: document.getElementById('form-confirm-email-change'),
    emailCodeNotice: document.getElementById('email-code-notice'),
    emailCodeInput: document.getElementById('email-change-code'),
    btnConfirmEmail: document.getElementById('btn-confirm-email-change'),
    btnCancelEmail: document.getElementById('btn-cancel-email-step'),
    confirmEmailFeedback: document.getElementById('email-change-confirm-feedback'),

    // Change Password
    formChangePw: document.getElementById('form-change-password'),
    pwCurrent: document.getElementById('pw-change-current'),
    pwNew: document.getElementById('pw-change-new'),
    pwConfirm: document.getElementById('pw-change-confirm'),
    pwMatchIndicator: document.getElementById('pw-change-match'),
    toggleShowPw: document.getElementById('toggle-show-all-pw'),
    btnSubmitPw: document.getElementById('btn-submit-pw-change'),
    pwFeedback: document.getElementById('pw-change-feedback'),

    // In-Session Password Reset via Email Code
    btnTogglePwResetMode: document.getElementById('btn-toggle-pw-reset-mode'),
    formResetPwEmail: document.getElementById('form-reset-password-email'),
    btnPwResetSendCode: document.getElementById('btn-pw-reset-send-code'),
    pwResetCodeSentStatus: document.getElementById('pw-reset-code-sent-status'),
    pwResetCodeInput: document.getElementById('pw-reset-code-input'),
    pwResetNewInput: document.getElementById('pw-reset-new-input'),
    pwResetConfirmInput: document.getElementById('pw-reset-confirm-input'),
    pwResetMatchIndicator: document.getElementById('pw-reset-match'),
    toggleShowAllPwReset: document.getElementById('toggle-show-all-pw-reset'),
    btnSwitchBackCurrentPw: document.getElementById('btn-switch-back-current-pw'),
    btnSubmitPwResetEmail: document.getElementById('btn-submit-pw-reset-email'),
    pwResetFeedback: document.getElementById('pw-reset-feedback'),

    // Logout
    btnLogout: document.getElementById('btn-account-logout'),

    // Delete Account
    btnStartDelete: document.getElementById('btn-start-delete-flow'),
    deleteModal: document.getElementById('delete-modal'),
    deleteStepWarning: document.getElementById('delete-step-warning'),
    btnDeleteProceedCode: document.getElementById('btn-delete-proceed-code'),
    btnDeleteCancel1: document.getElementById('btn-delete-cancel-1'),
    deleteStepConfirm: document.getElementById('delete-step-confirm'),
    formDeleteFinal: document.getElementById('form-delete-final'),
    deleteInputCode: document.getElementById('delete-input-code'),
    deleteInputPw: document.getElementById('delete-input-pw'),
    btnDeleteFinalExecute: document.getElementById('btn-delete-final-execute'),
    btnDeleteCancel2: document.getElementById('btn-delete-cancel-2'),
    deleteFeedback: document.getElementById('delete-feedback'),

    // Passkeys
    cardPasskeys: document.getElementById('card-passkeys'),
    passkeysUnsupportedAlert: document.getElementById('passkeys-unsupported-alert'),
    passkeysList: document.getElementById('passkeys-list'),
    passkeysEmpty: document.getElementById('passkeys-empty'),
    passkeysCountLabel: document.getElementById('passkeys-count-label'),
    btnAddPasskey: document.getElementById('btn-add-passkey'),
    passkeysFeedback: document.getElementById('passkeys-feedback'),

    toasts: document.getElementById('toasts'),
  };

  const CRYPTO = (typeof window !== 'undefined' && window.CRYPTO) ? window.CRYPTO : null;

  /* ---------------- Re-encryption on Password Change ---------------- */

  async function accountEncSalt() {
    const res = await fetch('/api/user/enc');
    if (!res.ok) throw new Error('Unable to read account encryption settings.');
    return (await res.json()).encSalt || '';
  }

  function accountSelfWrapKey(master) {
    return CRYPTO.hkdf(master, 'shareweb-self', 'shareweb-self', 256);
  }

  function accountStoreMaster(email, master) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('shareweb-keys', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'email' });
        };
        req.onsuccess = () => {
          try {
            const db = req.result;
            const tx = db.transaction('keys', 'readwrite');
            tx.objectStore('keys').put({ email, masterB64: CRYPTO.b64u(master), savedAt: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          } catch { resolve(); }
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  /** Unwrap each encrypted file's key with the OLD master/identity, re-wrap it
   *  under the NEW one, and return the list of `wrapOwner` replacements. */
  async function reencryptFiles(oldMaster, newMaster, setStatus) {
    const histRes = await fetch('/api/history');
    if (!histRes.ok) throw new Error('Unable to read your files.');
    const items = (await histRes.json()).items || [];

    const oldIdentity = await CRYPTO.deriveIdentity(oldMaster);
    const newIdentity = await CRYPTO.deriveIdentity(newMaster);

    const ops = [];
    const encItems = items.filter((it) => it.enc && it.id);
    for (let i = 0; i < encItems.length; i++) {
      const it = encItems[i];
      setStatus('Encrypting your files… (' + (i + 1) + ' of ' + encItems.length + ')');
      const metaRes = await fetch('/api/files/' + it.type + '/' + it.id + '/meta');
      if (!metaRes.ok) continue;
      let meta;
      try {
        meta = await metaRes.json();
      } catch { continue; }
      let K;
      let wrap;
      try {
        if (it.type === 'sent') {
          K = await CRYPTO.decryptBytes(await accountSelfWrapKey(oldMaster), meta.wrap);
          wrap = await CRYPTO.encryptBytes(await accountSelfWrapKey(newMaster), K);
        } else {
          K = await CRYPTO.decryptBytes(
            await CRYPTO.sharedWrapKey(oldIdentity.priv, meta.senderPub, oldIdentity.pub.x, meta.senderPub.x),
            meta.wrap
          );
          wrap = await CRYPTO.encryptBytes(
            await CRYPTO.sharedWrapKey(newIdentity.priv, meta.senderPub, newIdentity.pub.x, meta.senderPub.x),
            K
          );
        }
      } catch { continue; }
      ops.push({ type: it.type, id: it.id, wrap: { iv: wrap.iv, ct: wrap.ct } });
    }
    return ops;
  }

  function dismissLoader() {
    if (window.ShareWebLoader && typeof window.ShareWebLoader.hide === 'function') {
      window.ShareWebLoader.hide();
    }
    if (el.loader) {
      el.loader.style.opacity = '0';
      el.loader.style.pointerEvents = 'none';
      setTimeout(() => {
        try { el.loader.remove(); } catch (e) {}
      }, 350);
    }
  }

  function toast(message, type = 'info', ms = 3800) {
    if (!el.toasts) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = message;
    el.toasts.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    setTimeout(() => {
      t.classList.remove('visible');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  // Load User Info
  async function loadUserInfo() {
    try {
      const res = await fetch('/api/account/info');
      if (res.status === 401 || res.status === 403) {
        window.location.href = '/login?returnTo=' + encodeURIComponent(window.location.pathname);
        return;
      }
      const data = await res.json();
      if (data && data.ok) {
        state.user = data;
        renderProfile();
        loadPasskeys();
      }
    } catch (err) {
      console.error('Failed to load user info:', err);
    } finally {
      if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
        window.ShareWebLoader.whenReady({
          waitForFonts: true,
          waitForLanguage: true,
          images: el.avatar ? [el.avatar] : []
        });
      } else {
        dismissLoader();
      }
    }
  }

  function renderProfile() {
    if (!state.user) return;
    if (el.displayName) el.displayName.textContent = state.user.name || state.user.email.split('@')[0];
    if (el.displayEmail) el.displayEmail.textContent = state.user.email;
    if (el.avatar) {
      if (state.user.picture) {
        el.avatar.src = state.user.picture;
      } else {
        el.avatar.src = '/icons/icon-192.png';
      }
    }
    if (el.authBadge) {
      const isGoogle = state.user.auth === 'google';
      el.authBadge.textContent = isGoogle ? 'Google Account' : 'Email Account';
      if (isGoogle) {
        el.authBadge.style.background = 'rgba(234, 67, 53, 0.12)';
        el.authBadge.style.color = '#ea4335';
        el.authBadge.style.borderColor = 'rgba(234, 67, 53, 0.3)';
      }
    }
  }

  /* ---------------- Change Email Handlers ---------------- */

  if (el.formReqEmail) {
    el.formReqEmail.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = el.pwEmailReq.value.trim();
      const newEmail = el.newEmailInput.value.trim();

      el.reqEmailFeedback.textContent = '';
      el.reqEmailFeedback.className = 'feedback-msg';

      if (!currentPassword) {
        el.reqEmailFeedback.textContent = 'Please enter your current password.';
        el.reqEmailFeedback.className = 'feedback-msg error';
        return;
      }
      if (!newEmail) {
        el.reqEmailFeedback.textContent = 'Please enter a valid new email address.';
        el.reqEmailFeedback.className = 'feedback-msg error';
        return;
      }

      el.btnReqEmail.disabled = true;
      el.btnReqEmail.textContent = 'Sending code...';

      try {
        const res = await fetch('/api/account/email/request-change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newEmail }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          el.reqEmailFeedback.textContent = data.error || 'Failed to request email change.';
          el.reqEmailFeedback.className = 'feedback-msg error';
          return;
        }

        state.changeEmailToken = data.changeToken;
        el.emailCodeNotice.textContent = `Enter the 6-digit code sent to ${newEmail}`;
        el.formReqEmail.classList.add('hidden');
        el.formConfirmEmail.classList.remove('hidden');
        el.emailCodeInput.value = '';
        el.emailCodeInput.focus();
        toast(`Verification code sent to ${newEmail}`, 'info');
      } catch (err) {
        el.reqEmailFeedback.textContent = 'Network error. Please try again.';
        el.reqEmailFeedback.className = 'feedback-msg error';
      } finally {
        el.btnReqEmail.disabled = false;
        el.btnReqEmail.textContent = 'Send Verification Code';
      }
    });
  }

  if (el.btnCancelEmail) {
    el.btnCancelEmail.addEventListener('click', () => {
      el.formConfirmEmail.classList.add('hidden');
      el.formReqEmail.classList.remove('hidden');
      state.changeEmailToken = null;
      el.confirmEmailFeedback.textContent = '';
    });
  }

  if (el.formConfirmEmail) {
    el.formConfirmEmail.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = el.emailCodeInput.value.trim();
      if (!code || code.length !== 6) {
        el.confirmEmailFeedback.textContent = 'Please enter the full 6-digit code.';
        el.confirmEmailFeedback.className = 'feedback-msg error';
        return;
      }

      el.btnConfirmEmail.disabled = true;
      el.btnConfirmEmail.textContent = 'Verifying...';

      try {
        const res = await fetch('/api/account/email/confirm-change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            changeToken: state.changeEmailToken,
            code,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          el.confirmEmailFeedback.textContent = data.error || 'Verification failed.';
          el.confirmEmailFeedback.className = 'feedback-msg error';
          return;
        }

        // Email successfully changed!
        toast('Email updated successfully!', 'success');
        state.changeEmailToken = null;
        if (state.user) state.user.email = data.newEmail;
        renderProfile();

        el.formConfirmEmail.classList.add('hidden');
        el.formReqEmail.classList.remove('hidden');
        el.formReqEmail.reset();
        el.formConfirmEmail.reset();
        el.reqEmailFeedback.textContent = 'Email address updated successfully!';
        el.reqEmailFeedback.className = 'feedback-msg success';
      } catch (err) {
        el.confirmEmailFeedback.textContent = 'Network error. Please try again.';
        el.confirmEmailFeedback.className = 'feedback-msg error';
      } finally {
        el.btnConfirmEmail.disabled = false;
        el.btnConfirmEmail.textContent = 'Confirm Email Change';
      }
    });
  }

  /* ---------------- Change Password Handlers ---------------- */

  function checkPasswordRequirements(pw) {
    const len = pw.length >= 8;
    const hasCase = /[A-Z]/.test(pw) && /[a-z]/.test(pw);
    const hasNum = /[0-9]/.test(pw);

    const updateReq = (selector, met) => {
      const node = document.querySelector(selector);
      if (!node) return;
      if (met) {
        node.classList.remove('unmet');
        node.classList.add('met');
        const icon = node.querySelector('.req-icon');
        if (icon) icon.textContent = '✓';
      } else {
        node.classList.remove('met');
        node.classList.add('unmet');
        const icon = node.querySelector('.req-icon');
        if (icon) icon.textContent = '○';
      }
    };

    updateReq('.pw-req[data-req="len"]', len);
    updateReq('.pw-req[data-req="case"]', hasCase);
    updateReq('.pw-req[data-req="num"]', hasNum);

    return len && hasCase && hasNum;
  }

  function checkPasswordMatch() {
    if (!el.pwNew || !el.pwConfirm || !el.pwMatchIndicator) return true;
    const p1 = el.pwNew.value;
    const p2 = el.pwConfirm.value;
    if (!p2) {
      el.pwMatchIndicator.textContent = '';
      el.pwMatchIndicator.className = 'pw-match-indicator';
      return false;
    }
    if (p1 === p2) {
      el.pwMatchIndicator.textContent = 'Passwords match';
      el.pwMatchIndicator.className = 'pw-match-indicator match';
      return true;
    } else {
      el.pwMatchIndicator.textContent = 'Passwords do not match';
      el.pwMatchIndicator.className = 'pw-match-indicator mismatch';
      return false;
    }
  }

  if (el.pwNew) {
    el.pwNew.addEventListener('input', () => {
      checkPasswordRequirements(el.pwNew.value);
      checkPasswordMatch();
    });
  }
  if (el.pwConfirm) {
    el.pwConfirm.addEventListener('input', checkPasswordMatch);
  }

  // Universal Eye Button Toggle for all password fields
  document.querySelectorAll('.btn-toggle-eye').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const targetId = btn.getAttribute('data-target');
      const input = targetId ? document.getElementById(targetId) : btn.parentElement.querySelector('input');
      if (!input) return;

      const isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';

      const openIcon = btn.querySelector('.eye-open-icon');
      const offIcon = btn.querySelector('.eye-off-icon');

      if (openIcon && offIcon) {
        if (isPw) {
          openIcon.classList.add('hidden');
          offIcon.classList.remove('hidden');
          btn.setAttribute('title', 'Hide password');
          btn.setAttribute('aria-label', 'Hide password');
        } else {
          openIcon.classList.remove('hidden');
          offIcon.classList.add('hidden');
          btn.setAttribute('title', 'Show password');
          btn.setAttribute('aria-label', 'Show password');
        }
      }
    });
  });

  if (el.formChangePw) {
    el.formChangePw.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = el.pwCurrent.value;
      const newPassword = el.pwNew.value;
      const confirmPassword = el.pwConfirm.value;

      el.pwFeedback.textContent = '';
      el.pwFeedback.className = 'feedback-msg';

      if (!currentPassword) {
        el.pwFeedback.textContent = 'Please enter your current password.';
        el.pwFeedback.className = 'feedback-msg error';
        return;
      }
      if (!checkPasswordRequirements(newPassword)) {
        el.pwFeedback.textContent = 'Please meet all password requirements.';
        el.pwFeedback.className = 'feedback-msg error';
        return;
      }
      if (newPassword !== confirmPassword) {
        el.pwFeedback.textContent = 'Passwords do not match.';
        el.pwFeedback.className = 'feedback-msg error';
        return;
      }

      el.btnSubmitPw.disabled = true;
      el.btnSubmitPw.textContent = 'Updating...';

      const reencModal = document.getElementById('reenc-modal');
      const reencStatus = document.getElementById('reenc-status');
      const encSalt = await accountEncSalt().catch(() => '');
      if (reencModal) reencModal.classList.remove('hidden');

      let done = false;
      try {
        let reenc = [];
        let encName = null;
        let newMaster = null;

        if (encSalt && CRYPTO) {
          if (reencStatus) reencStatus.textContent = 'Reading your files…';
          const oldMaster = await CRYPTO.pbkdf2Master(currentPassword, encSalt);
          newMaster = await CRYPTO.pbkdf2Master(newPassword, encSalt);
          reenc = await reencryptFiles(oldMaster, newMaster, (s) => {
            if (reencStatus) reencStatus.textContent = s;
          });
          if (state.user && state.user.name) {
            encName = await CRYPTO.encryptBytes(newMaster, new TextEncoder().encode(state.user.name));
          }
        }

        if (reencStatus) reencStatus.textContent = 'Saving your new password…';

        const res = await fetch('/api/account/password/change', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPassword,
            newPassword,
            encName,
            reenc,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          el.pwFeedback.textContent = data.error || 'Failed to update password.';
          el.pwFeedback.className = 'feedback-msg error';
          return;
        }

        if (newMaster && encSalt) {
          try {
            await accountStoreMaster(state.user && state.user.email, newMaster);
            const identity = await CRYPTO.deriveIdentity(newMaster);
            await fetch('/api/user/pubkey', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pub: identity.pub }),
            }).catch(() => {});
          } catch (e) {}
        }

        toast('Password changed successfully!', 'success');
        el.formChangePw.reset();
        checkPasswordRequirements('');
        if (el.pwMatchIndicator) el.pwMatchIndicator.textContent = '';
        el.pwFeedback.textContent = 'Password updated successfully!';
        el.pwFeedback.className = 'feedback-msg success';
        done = true;
      } catch (err) {
        el.pwFeedback.textContent = 'Network error. Please try again.';
        el.pwFeedback.className = 'feedback-msg error';
      } finally {
        if (done) {
          const spin = reencModal && reencModal.querySelector('.reenc-spinner');
          const check = reencModal && reencModal.querySelector('.reenc-check');
          const title = reencModal && document.getElementById('reenc-title');
          if (spin) spin.classList.add('hidden');
          if (check) check.classList.remove('hidden');
          if (title) title.textContent = 'Done!';
          if (reencStatus) reencStatus.textContent = 'All files are encrypted with your new password.';
          el.btnSubmitPw.disabled = false;
          el.btnSubmitPw.textContent = 'Update Password';
          setTimeout(() => { window.location.href = '/app'; }, 1600);
        } else {
          if (reencModal) reencModal.classList.add('hidden');
          el.btnSubmitPw.disabled = false;
          el.btnSubmitPw.textContent = 'Update Password';
        }
      }
    });
  }

  /* ---------------- In-Session Password Reset (Solution 2) ---------------- */

  let pwResetToken = null;

  if (el.btnTogglePwResetMode) {
    el.btnTogglePwResetMode.addEventListener('click', () => {
      if (el.formChangePw) el.formChangePw.classList.add('hidden');
      if (el.formResetPwEmail) el.formResetPwEmail.classList.remove('hidden');
      if (el.btnTogglePwResetMode.parentElement) el.btnTogglePwResetMode.parentElement.classList.add('hidden');
      if (el.pwFeedback) el.pwFeedback.textContent = '';
      if (el.pwResetFeedback) el.pwResetFeedback.textContent = '';
    });
  }

  if (el.btnSwitchBackCurrentPw) {
    el.btnSwitchBackCurrentPw.addEventListener('click', () => {
      if (el.formResetPwEmail) el.formResetPwEmail.classList.add('hidden');
      if (el.formChangePw) el.formChangePw.classList.remove('hidden');
      if (el.btnTogglePwResetMode && el.btnTogglePwResetMode.parentElement) {
        el.btnTogglePwResetMode.parentElement.classList.remove('hidden');
      }
      if (el.pwFeedback) el.pwFeedback.textContent = '';
      if (el.pwResetFeedback) el.pwResetFeedback.textContent = '';
    });
  }

  if (el.btnPwResetSendCode) {
    el.btnPwResetSendCode.addEventListener('click', async () => {
      el.btnPwResetSendCode.disabled = true;
      el.btnPwResetSendCode.textContent = 'Sending Code...';
      if (el.pwResetFeedback) el.pwResetFeedback.textContent = '';
      if (el.pwResetCodeSentStatus) el.pwResetCodeSentStatus.textContent = '';

      try {
        const res = await fetch('/api/account/password/request-reset-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (el.pwResetFeedback) {
            el.pwResetFeedback.textContent = data.error || 'Failed to send verification code.';
            el.pwResetFeedback.className = 'feedback-msg error';
          }
          return;
        }

        pwResetToken = data.pwResetToken;
        toast('Verification code sent to your email!', 'info');
        if (el.pwResetCodeSentStatus) {
          el.pwResetCodeSentStatus.textContent = '✓ Code sent to your email';
          el.pwResetCodeSentStatus.style.color = 'var(--success)';
        }
        if (el.pwResetCodeInput) el.pwResetCodeInput.focus();
      } catch (err) {
        if (el.pwResetFeedback) {
          el.pwResetFeedback.textContent = 'Network error. Please try again.';
          el.pwResetFeedback.className = 'feedback-msg error';
        }
      } finally {
        el.btnPwResetSendCode.disabled = false;
        el.btnPwResetSendCode.textContent = 'Resend Code';
      }
    });
  }

  function checkResetPasswordRequirements(pw) {
    const len = pw.length >= 8;
    const hasCase = /[A-Z]/.test(pw) && /[a-z]/.test(pw);
    const hasNum = /[0-9]/.test(pw);

    const updateReq = (selector, met) => {
      const node = document.querySelector(selector);
      if (!node) return;
      if (met) {
        node.classList.remove('unmet');
        node.classList.add('met');
        const icon = node.querySelector('.req-icon');
        if (icon) icon.textContent = '✓';
      } else {
        node.classList.remove('met');
        node.classList.add('unmet');
        const icon = node.querySelector('.req-icon');
        if (icon) icon.textContent = '○';
      }
    };

    updateReq('#pw-reset-reqs .pw-req[data-req="len"]', len);
    updateReq('#pw-reset-reqs .pw-req[data-req="case"]', hasCase);
    updateReq('#pw-reset-reqs .pw-req[data-req="num"]', hasNum);

    return len && hasCase && hasNum;
  }

  function checkResetPasswordMatch() {
    if (!el.pwResetNewInput || !el.pwResetConfirmInput || !el.pwResetMatchIndicator) return true;
    const p1 = el.pwResetNewInput.value;
    const p2 = el.pwResetConfirmInput.value;
    if (!p2) {
      el.pwResetMatchIndicator.textContent = '';
      el.pwResetMatchIndicator.className = 'pw-match-indicator';
      return false;
    }
    if (p1 === p2) {
      el.pwResetMatchIndicator.textContent = 'Passwords match';
      el.pwResetMatchIndicator.className = 'pw-match-indicator match';
      return true;
    } else {
      el.pwResetMatchIndicator.textContent = 'Passwords do not match';
      el.pwResetMatchIndicator.className = 'pw-match-indicator mismatch';
      return false;
    }
  }

  if (el.pwResetNewInput) {
    el.pwResetNewInput.addEventListener('input', () => {
      checkResetPasswordRequirements(el.pwResetNewInput.value);
      checkResetPasswordMatch();
    });
  }
  if (el.pwResetConfirmInput) {
    el.pwResetConfirmInput.addEventListener('input', checkResetPasswordMatch);
  }



  if (el.formResetPwEmail) {
    el.formResetPwEmail.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = el.pwResetCodeInput ? el.pwResetCodeInput.value.trim() : '';
      const newPassword = el.pwResetNewInput ? el.pwResetNewInput.value : '';
      const confirmPassword = el.pwResetConfirmInput ? el.pwResetConfirmInput.value : '';

      el.pwResetFeedback.textContent = '';
      el.pwResetFeedback.className = 'feedback-msg';

      if (!pwResetToken) {
        el.pwResetFeedback.textContent = 'Please click "Send 6-Digit Code to Email" first.';
        el.pwResetFeedback.className = 'feedback-msg error';
        return;
      }
      if (!code || code.length !== 6) {
        el.pwResetFeedback.textContent = 'Please enter the 6-digit code sent to your email.';
        el.pwResetFeedback.className = 'feedback-msg error';
        return;
      }
      if (!checkResetPasswordRequirements(newPassword)) {
        el.pwResetFeedback.textContent = 'Please meet all password requirements.';
        el.pwResetFeedback.className = 'feedback-msg error';
        return;
      }
      if (newPassword !== confirmPassword) {
        el.pwResetFeedback.textContent = 'Passwords do not match.';
        el.pwResetFeedback.className = 'feedback-msg error';
        return;
      }

      el.btnSubmitPwResetEmail.disabled = true;
      el.btnSubmitPwResetEmail.textContent = 'Resetting...';

      try {
        const res = await fetch('/api/account/password/reset-with-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pwResetToken,
            code,
            newPassword,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          el.pwResetFeedback.textContent = data.error || 'Failed to reset password.';
          el.pwResetFeedback.className = 'feedback-msg error';
          return;
        }

        toast('Password successfully reset and updated!', 'success');
        el.formResetPwEmail.reset();
        pwResetToken = null;
        checkResetPasswordRequirements('');
        if (el.pwResetMatchIndicator) el.pwResetMatchIndicator.textContent = '';
        if (el.pwResetCodeSentStatus) el.pwResetCodeSentStatus.textContent = '';
        el.pwResetFeedback.textContent = 'Password reset successfully!';
        el.pwResetFeedback.className = 'feedback-msg success';
      } catch (err) {
        el.pwResetFeedback.textContent = 'Network error. Please try again.';
        el.pwResetFeedback.className = 'feedback-msg error';
      } finally {
        el.btnSubmitPwResetEmail.disabled = false;
        el.btnSubmitPwResetEmail.textContent = 'Reset & Update Password';
      }
    });
  }

  /* ---------------- Passkeys & WebAuthn Handlers ---------------- */

  function t(key, fallback = '') {
    try {
      const lang = localStorage.getItem('sw_lang') || (window.ShareWebI18n && window.ShareWebI18n.resolveEffectiveLanguage && window.ShareWebI18n.resolveEffectiveLanguage()) || 'en';
      const dict = (window.ShareWebI18n && window.ShareWebI18n.PAGE_TRANSLATIONS && window.ShareWebI18n.PAGE_TRANSLATIONS[lang]) || {};
      return dict[key] || fallback || key;
    } catch (_) {
      return fallback || key;
    }
  }

  let passkeysMod = null;
  async function getPasskeys() {
    if (!passkeysMod) {
      passkeysMod = await import('/modules/passkeys.js');
    }
    return passkeysMod;
  }

  async function loadPasskeys() {
    if (!el.cardPasskeys) return;
    try {
      const { isPasskeySupported, getAccountPasskeys } = await getPasskeys();
      const supported = await isPasskeySupported();
      if (!supported) {
        if (el.passkeysUnsupportedAlert) el.passkeysUnsupportedAlert.classList.remove('hidden');
        if (el.btnAddPasskey) el.btnAddPasskey.disabled = true;
      } else {
        if (el.passkeysUnsupportedAlert) el.passkeysUnsupportedAlert.classList.add('hidden');
        if (el.btnAddPasskey) el.btnAddPasskey.disabled = false;
      }

      const passkeys = await getAccountPasskeys();
      renderPasskeys(passkeys);
    } catch (err) {
      console.warn('Failed to load passkeys:', err);
    }
  }

  function renderPasskeys(passkeys = []) {
    if (!el.passkeysList) return;
    el.passkeysList.innerHTML = '';

    if (el.passkeysCountLabel) {
      el.passkeysCountLabel.textContent = passkeys.length === 1
        ? `1 ${t('passkeySaved', 'passkey saved')}`
        : `${passkeys.length} ${t('passkeysSaved', 'passkeys saved')}`;
    }

    if (!passkeys.length) {
      if (el.passkeysEmpty) el.passkeysEmpty.classList.remove('hidden');
      return;
    }

    if (el.passkeysEmpty) el.passkeysEmpty.classList.add('hidden');

    passkeys.forEach((pk) => {
      const item = document.createElement('div');
      item.className = 'passkey-item';
      item.id = `passkey-${pk.id}`;

      const left = document.createElement('div');
      left.className = 'passkey-item-left';

      const icon = document.createElement('div');
      icon.className = 'passkey-item-icon';
      icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 004 11m0 0a8 8 0 001.328 4.417m0 0c.934 1.776 2.25 3.321 3.844 4.502"/>
      </svg>`;

      const info = document.createElement('div');
      info.className = 'passkey-item-info';

      const title = document.createElement('div');
      title.className = 'passkey-item-name';
      title.textContent = pk.name || 'Passkey Authenticator';

      const meta = document.createElement('div');
      meta.className = 'passkey-item-meta';
      const createdStr = pk.createdAt ? new Date(pk.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      meta.textContent = createdStr ? `${t('addedOn', 'Added')} ${createdStr}${pk.counter > 0 ? ' • ' + t('passkeyUsed', 'Used') : ''}` : (pk.counter > 0 ? t('passkeyUsed', 'Used') : t('passkeyNotUsed', 'Not used yet'));

      info.appendChild(title);
      info.appendChild(meta);
      left.appendChild(icon);
      left.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'passkey-item-actions';

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'btn-icon-danger';
      btnDelete.title = t('delete', 'Remove');
      btnDelete.setAttribute('aria-label', `Remove ${pk.name || 'Passkey'}`);
      btnDelete.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
      </svg>`;

      btnDelete.addEventListener('click', async () => {
        const confirmMsg = t('passkeyDeleteConfirm', 'Are you sure you want to remove this passkey?');
        if (!confirm(confirmMsg)) return;

        btnDelete.disabled = true;
        try {
          const { deleteAccountPasskey } = await getPasskeys();
          const ok = await deleteAccountPasskey(pk.id);
          if (ok) {
            toast(t('passkeyDeletedSuccess', 'Passkey removed successfully.'), 'success');
            await loadPasskeys();
          } else {
            toast(t('passkeyDeleteFailed', 'Failed to remove passkey.'), 'error');
          }
        } catch (err) {
          toast(err.message || t('passkeyDeleteFailed', 'Failed to remove passkey.'), 'error');
        } finally {
          btnDelete.disabled = false;
        }
      });

      actions.appendChild(btnDelete);

      item.appendChild(left);
      item.appendChild(actions);
      el.passkeysList.appendChild(item);
    });
  }

  if (el.btnAddPasskey) {
    el.btnAddPasskey.addEventListener('click', async () => {
      if (el.passkeysFeedback) el.passkeysFeedback.textContent = '';
      el.btnAddPasskey.disabled = true;
      try {
        const { registerPasskey } = await getPasskeys();
        await registerPasskey();
        toast(t('passkeyCreatedSuccess', 'Passkey created successfully!'), 'success');
        await loadPasskeys();
      } catch (err) {
        console.warn('Passkey registration error:', err);
        const isCancelled = err.name === 'NotAllowedError' || err.message?.includes('cancelled');
        if (!isCancelled) {
          toast(err.message || t('passkeyCreateFailed', 'Failed to create passkey.'), 'error');
        }
      } finally {
        el.btnAddPasskey.disabled = false;
      }
    });
  }

  /* ---------------- IndexedDB Key Cache Wipe ---------------- */

  async function wipeMasterKeyCache(email) {
    try {
      const req = indexedDB.open('shareweb-keys', 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('keys')) return;
          const tx = db.transaction('keys', 'readwrite');
          if (email) {
            tx.objectStore('keys').delete(email);
          } else {
            tx.objectStore('keys').clear();
          }
        } catch {}
      };
    } catch {}
  }

  /* ---------------- Logout ---------------- */

  if (el.btnLogout) {
    el.btnLogout.addEventListener('click', async () => {
      try {
        await wipeMasterKeyCache(state.user && state.user.email);
      } catch {}
      try {
        localStorage.removeItem('ds-last-account');
        localStorage.removeItem('ds-room');
        localStorage.removeItem('sw_session_token');
        sessionStorage.clear();
        await fetch('/auth/logout', { method: 'POST' });
      } catch {}
      window.location.href = '/login';
    });
  }

  /* ---------------- Delete Account Handlers ---------------- */

  function showDeleteModal() {
    if (!el.deleteModal) return;
    el.deleteModal.classList.remove('hidden');
    el.deleteStepWarning.classList.remove('hidden');
    el.deleteStepConfirm.classList.add('hidden');
    if (el.deleteFeedback) el.deleteFeedback.textContent = '';
  }

  function hideDeleteModal() {
    if (!el.deleteModal) return;
    el.deleteModal.classList.add('hidden');
    state.deleteAccountToken = null;
    if (el.formDeleteFinal) el.formDeleteFinal.reset();
  }

  if (el.btnStartDelete) {
    el.btnStartDelete.addEventListener('click', showDeleteModal);
  }
  if (el.btnDeleteCancel1) {
    el.btnDeleteCancel1.addEventListener('click', hideDeleteModal);
  }
  if (el.btnDeleteCancel2) {
    el.btnDeleteCancel2.addEventListener('click', hideDeleteModal);
  }

  // Step 1 -> Step 2: Request Security Code
  if (el.btnDeleteProceedCode) {
    el.btnDeleteProceedCode.addEventListener('click', async () => {
      el.btnDeleteProceedCode.disabled = true;
      el.btnDeleteProceedCode.textContent = 'Sending security code...';

      try {
        const res = await fetch('/api/account/delete/request-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          toast(data.error || 'Failed to send security code.', 'error');
          return;
        }

        state.deleteAccountToken = data.deleteToken;
        el.deleteStepWarning.classList.add('hidden');
        el.deleteStepConfirm.classList.remove('hidden');
        if (el.deleteInputCode) {
          el.deleteInputCode.value = '';
          el.deleteInputCode.focus();
        }
        toast('Security verification code sent to your email.', 'info');
      } catch (err) {
        toast('Network error. Please try again.', 'error');
      } finally {
        el.btnDeleteProceedCode.disabled = false;
        el.btnDeleteProceedCode.textContent = "I know what I'm doing";
      }
    });
  }

  // Step 2 -> Confirm Permanent Deletion
  if (el.formDeleteFinal) {
    el.formDeleteFinal.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = el.deleteInputCode.value.trim();
      const password = el.deleteInputPw.value;

      el.deleteFeedback.textContent = '';

      if (!code || code.length !== 6) {
        el.deleteFeedback.textContent = 'Please enter the 6-digit code.';
        return;
      }
      if (!password) {
        el.deleteFeedback.textContent = 'Please enter your password.';
        return;
      }

      el.btnDeleteFinalExecute.disabled = true;
      el.btnDeleteFinalExecute.textContent = 'Deleting Account...';

      try {
        const res = await fetch('/api/account/delete/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deleteToken: state.deleteAccountToken,
            code,
            password,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          el.deleteFeedback.textContent = data.error || 'Failed to delete account.';
          return;
        }

        // Account successfully deleted!
        try {
          await wipeMasterKeyCache(state.user && state.user.email);
          localStorage.removeItem('ds-last-account');
          localStorage.removeItem('ds-room');
          sessionStorage.clear();
        } catch {}
        hideDeleteModal();
        alert('Your account has been deleted successfully. You will be redirected to the homepage.');
        window.location.href = '/';
      } catch (err) {
        el.deleteFeedback.textContent = 'Network error. Please try again.';
      } finally {
        el.btnDeleteFinalExecute.disabled = false;
        el.btnDeleteFinalExecute.textContent = 'Delete the Account';
      }
    });
  }

  // Initialize
  loadUserInfo();
})();
