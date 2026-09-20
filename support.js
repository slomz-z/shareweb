let currentUser = null;
let currentAuthSource = null;
let myTickets = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function t(key, fallback) {
  const lang = document.documentElement.getAttribute('lang') || 'en';
  const dict = window.ShareWebI18n?.PAGE_TRANSLATIONS?.[lang] || window.ShareWebI18n?.PAGE_TRANSLATIONS?.['en'] || {};
  return dict[key] || fallback || key;
}

// 1. Check authenticated user status (from /app or /support session)
async function loadAuth() {
  const gBtn = document.getElementById('support-google-btn');
  if (gBtn && !gBtn._boundBreakout) {
    gBtn._boundBreakout = true;
    gBtn.addEventListener('click', (e) => {
      if (window.self !== window.top) {
        e.preventDefault();
        window.top.location.href = window.location.origin + '/auth/google?returnTo=/support';
      }
    });
  }
  const loginSection = document.getElementById('support-login-section');
  const mainGrid = document.getElementById('support-main-grid');
  const userTag = document.getElementById('support-user-tag');
  const meName = document.getElementById('support-me-name');
  const meEmail = document.getElementById('support-me-email');
  const dropdownName = document.getElementById('support-dropdown-name');
  const dropdownEmail = document.getElementById('support-dropdown-email');
  const avatarWrap = document.getElementById('support-avatar-wrap');
  const menuAvatarWrap = document.getElementById('support-menu-avatar');
  const logoutBtn = document.getElementById('support-logout-btn');
  const headerOpenAppBtn = document.getElementById('header-open-app-btn');
  const dropdownAppLink = document.getElementById('support-dropdown-app-link');
  const suspensionBanner = document.getElementById('suspension-appeal-banner');
  const suspensionReasonText = document.getElementById('suspension-reason-text');
  const emailInput = document.getElementById('ticket-email');
  const subjectInput = document.getElementById('ticket-subject');

  try {
    const res = await fetch('/api/support/auth-state');
    const data = await res.json();

    if (data.ok && data.authenticated && data.user) {
      currentUser = data.user;

      // Show Main Form Grid, hide login prompt
      loginSection?.classList.add('hidden');
      mainGrid?.classList.remove('hidden');

      if (emailInput) {
        emailInput.value = currentUser.email;
        emailInput.readOnly = true;
      }

      if (currentUser.settings && currentUser.settings.theme) {
        if (currentUser.settings.theme === 'system') {
          document.documentElement?.removeAttribute('data-theme');
        } else {
          document.documentElement?.setAttribute('data-theme', currentUser.settings.theme);
        }
      }

      // Update App-Style Profile Header (.me)
      if (userTag) {
        userTag.classList.remove('hidden');
        const name = currentUser.name || currentUser.email.split('@')[0];
        const email = currentUser.email;
        const init = (name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();

        if (meName) meName.textContent = name;
        if (meEmail) meEmail.textContent = email;
        if (dropdownName) dropdownName.textContent = name;
        if (dropdownEmail) dropdownEmail.textContent = email;

        const avatarPic = currentUser.picture || `/api/avatar/${encodeURIComponent(email)}`;
        const avatarHtml = `<img src="${escapeHtml(avatarPic)}" class="avatar" alt="" onerror="this.outerHTML='<span class=\\'initials\\'>${escapeHtml(init)}</span>'" />`;
        if (avatarWrap) avatarWrap.innerHTML = avatarHtml;
        if (menuAvatarWrap) menuAvatarWrap.innerHTML = avatarHtml;
      }

      logoutBtn?.classList.remove('hidden');

      // Check Account Suspension Status
      if (currentUser.isBanned) {
        suspensionBanner?.classList.remove('hidden');
        if (suspensionReasonText) {
          const reason = currentUser.banReason || t('restricted', 'Account Suspended');
          suspensionReasonText.textContent = t('suspensionBannerReasonDesc', 'Your ShareWeb account has been suspended by an administrator (Reason: {reason}). While your account is suspended, access to ShareWeb (/app and sharing rooms) is disabled. You may communicate with moderators and submit an appeal inquiry below.').replace('{reason}', reason);
        }
        // Hide direct links to /app for suspended users
        headerOpenAppBtn?.classList.add('hidden');
        dropdownAppLink?.classList.add('hidden');
        if (subjectInput && !subjectInput.value) {
          subjectInput.value = t('chipSuspensionAppeal', 'Suspension Appeal');
        }
      } else {
        suspensionBanner?.classList.add('hidden');
        headerOpenAppBtn?.classList.remove('hidden');
        dropdownAppLink?.classList.remove('hidden');
      }

      // Resolve language immediately before ticket rendering
      if (window.ShareWebI18n?.initPageI18n) {
        try { await window.ShareWebI18n.initPageI18n(); } catch {}
      }

      await loadMyTickets();
    } else {
      // Unauthenticated
      currentUser = null;
      loginSection?.classList.remove('hidden');
      mainGrid?.classList.add('hidden');
      userTag?.classList.add('hidden');
      suspensionBanner?.classList.add('hidden');
      headerOpenAppBtn?.classList.add('hidden');
      if (window.ShareWebI18n?.initPageI18n) {
        try { await window.ShareWebI18n.initPageI18n(); } catch {}
      }
    }
  } catch (err) {
    console.error('Failed to load auth state', err);
  } finally {
    const supportImages = [];
    const aWrap = document.getElementById('support-avatar-wrap');
    const maWrap = document.getElementById('support-menu-avatar') || document.getElementById('support-menu-avatar-wrap');
    if (aWrap) supportImages.push(...aWrap.querySelectorAll('img'));
    if (maWrap) supportImages.push(...maWrap.querySelectorAll('img'));

    if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
      window.ShareWebLoader.whenReady({
        waitForFonts: true,
        waitForLanguage: true,
        images: supportImages
      });
    } else if (window.hidePageLoader) {
      window.hidePageLoader();
    }
  }
}

// 1.1 Support User Dropdown Menu Handlers
const supportMenuBtn = document.getElementById('support-menu-btn');
const supportUserMenu = document.getElementById('support-user-menu');

supportMenuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = supportUserMenu?.classList.contains('hidden');
  if (isHidden) {
    supportUserMenu?.classList.remove('hidden');
    supportMenuBtn.classList.add('open');
  } else {
    supportUserMenu?.classList.add('hidden');
    supportMenuBtn.classList.remove('open');
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#support-user-tag')) {
    supportUserMenu?.classList.add('hidden');
    supportMenuBtn?.classList.remove('open');
  }
});

// 1.2 Support Logout Button
document.getElementById('support-logout-btn')?.addEventListener('click', async () => {
  try {
    localStorage.removeItem('ds-last-account');
    localStorage.removeItem('ds-room');
    sessionStorage.clear();
  } catch {}
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { 'Accept': 'application/json' } });
  } catch {}
  try {
    await fetch('/api/support/logout', { method: 'POST' });
  } catch {}
  window.location.href = '/';
});

// 2. Load tickets for current user
async function loadMyTickets() {
  if (!currentUser?.email) {
    const container = document.getElementById('tickets-container');
    if (container) {
      container.innerHTML = `<div class="empty-state" data-i18n="signInToViewInquiries">${escapeHtml(t('signInToViewInquiries', 'Sign in above to view your inquiries.'))}</div>`;
    }
    return;
  }

  try {
    const res = await fetch('/api/support/my-tickets');
    const data = await res.json();
    myTickets = data.tickets || [];
    renderTickets();
  } catch (err) {
    console.error('Failed to load tickets', err);
    const container = document.getElementById('tickets-container');
    if (container) {
      container.innerHTML = `<div class="empty-state" data-i18n="failedToLoadInquiries">${escapeHtml(t('failedToLoadInquiries', 'Failed to load inquiries.'))}</div>`;
    }
  }
}

// 3. Render tickets list
function renderTickets() {
  const container = document.getElementById('tickets-container');
  if (!container) return;

  if (myTickets.length === 0) {
    container.innerHTML = `<div class="empty-state" data-i18n="noInquiriesYet">${escapeHtml(t('noInquiriesYet', 'No inquiries found for your account yet.'))}</div>`;
    return;
  }

  container.innerHTML = myTickets.map(tkt => {
    const statusClass = tkt.status === 'resolved' ? 'pill-resolved' : (tkt.status === 'in_progress' ? 'pill-progress' : 'pill-open');
    const statusKey = tkt.status === 'resolved' ? 'statusResolved' : (tkt.status === 'in_progress' ? 'statusInProgress' : 'statusOpen');
    const statusFallback = tkt.status === 'resolved' ? 'Resolved' : (tkt.status === 'in_progress' ? 'In Progress' : 'Open');
    const statusText = t(statusKey, statusFallback);
    const unreadPill = tkt.hasUnreadReply ? `<span class="pill pill-unread" data-i18n="unreadReplyBadge">${escapeHtml(t('unreadReplyBadge', 'New Staff Reply'))}</span>` : '';
    const dateStr = new Date(tkt.createdAt).toLocaleDateString();

    const messagesHtml = (tkt.messages || []).map(m => {
      const isStaff = m.sender === 'moderator';
      const senderBadge = isStaff
        ? `<span class="pill pill-progress" style="font-size:10px;" data-i18n="moderatorStaff">${escapeHtml(t('moderatorStaff', 'Moderator / Staff'))}</span>`
        : `<span style="color:#94a3b8; font-size:11px;" data-i18n="you">${escapeHtml(t('you', 'You'))}</span>`;
      const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      return `<div class="msg-bubble ${isStaff ? 'moderator' : 'user'}">
        <div class="msg-meta">
          <span>${escapeHtml(m.senderName)} ${senderBadge}</span>
          <span>${timeStr}</span>
        </div>
        <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(m.text)}</div>
      </div>`;
    }).join('');

    const tHeader = t('ticketHeader', 'Ticket #{id}').replace('{id}', tkt.id);
    const tCreated = t('createdDate', 'Created {date}').replace('{date}', dateStr);
    const tMsgCount = t('messagesCount', '{n} messages').replace('{n}', tkt.messages ? tkt.messages.length : 0);

    return `<div class="ticket-card ${tkt.hasUnreadReply ? 'has-unread' : ''}" id="card-${tkt.id}">
      <div class="ticket-header" data-id="${tkt.id}">
        <div class="ticket-title-group">
          <div class="ticket-subject">${escapeHtml(tkt.subject)}</div>
          <div class="ticket-meta">
            <span>${escapeHtml(tHeader)}</span>
            <span>&bull;</span>
            <span>${escapeHtml(tCreated)}</span>
            <span>&bull;</span>
            <span>${escapeHtml(tMsgCount)}</span>
          </div>
        </div>
        <div class="ticket-badges">
          ${unreadPill}
          <span class="pill ${statusClass}" data-i18n="${statusKey}">${escapeHtml(statusText)}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="ticket-body" id="body-${tkt.id}">
        <div class="messages-stream">
          ${messagesHtml}
        </div>
        <form class="reply-form" data-id="${tkt.id}">
          <textarea class="form-input form-reply-textarea" placeholder="${escapeHtml(t('replyPlaceholder', 'Type a follow-up reply... (Shift + Enter for new line, Enter to send)'))}" data-i18n-ph="replyPlaceholder" rows="1" required></textarea>
          <button type="submit" class="nav-btn primary" style="white-space:nowrap;" data-i18n="replyBtn">${escapeHtml(t('replyBtn', 'Reply'))}</button>
        </form>
      </div>
    </div>`;
  }).join('');
}

window.addEventListener('shareweb:languageChanged', () => {
  if (currentUser) {
    renderTickets();
  }
});


// 4. Ticket toggle accordion & mark read
document.getElementById('tickets-container').addEventListener('click', async (e) => {
  const header = e.target.closest('.ticket-header');
  if (!header) return;
  const ticketId = header.dataset.id;
  const body = document.getElementById(`body-${ticketId}`);
  const card = document.getElementById(`card-${ticketId}`);
  if (!body) return;

  const isOpen = body.classList.contains('open');
  if (isOpen) {
    body.classList.remove('open');
  } else {
    body.classList.add('open');
    if (card && card.classList.contains('has-unread')) {
      card.classList.remove('has-unread');
      fetch(`/api/support/tickets/${encodeURIComponent(ticketId)}/mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    }
  }
});

// 4.1 Keydown handler: Enter to send, Shift + Enter for soft return / new line
document.getElementById('tickets-container').addEventListener('keydown', (e) => {
  if (e.target && e.target.classList.contains('form-reply-textarea')) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.target.closest('.reply-form');
      form?.requestSubmit();
    }
  }
});

// 5. Follow-up reply submission
document.getElementById('tickets-container').addEventListener('submit', async (e) => {
  const form = e.target.closest('.reply-form');
  if (!form) return;
  e.preventDefault();
  const ticketId = form.dataset.id;
  const input = form.querySelector('textarea, input');
  const message = input.value.trim();
  if (!message) return;

  input.disabled = true;
  try {
    const res = await fetch(`/api/support/tickets/${encodeURIComponent(ticketId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      await loadMyTickets();
      const body = document.getElementById(`body-${ticketId}`);
      if (body) body.classList.add('open');
    } else {
      alert(data.error || t('failedToSendReply', 'Failed to send reply'));
    }
  } catch {
    alert(t('networkError', 'Network error occurred.'));
  } finally {
    input.disabled = false;
    input.focus();
  }
});

// 6. Submit new ticket
document.getElementById('support-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('ticket-submit-btn');
  const subject = document.getElementById('ticket-subject').value.trim();
  const message = document.getElementById('ticket-message').value.trim();

  if (!subject || !message) return;

  btn.disabled = true;
  btn.textContent = t('sendingInquiry', 'Sending Inquiry...');

  try {
    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('ticket-subject').value = '';
      document.getElementById('ticket-message').value = '';
      const alertEl = document.getElementById('ticket-success-alert');
      alertEl.classList.remove('hidden');
      setTimeout(() => alertEl.scrollIntoView({ behavior: 'smooth' }), 100);
      await loadMyTickets();
    } else {
      alert(data.error || t('failedToSubmitInquiry', 'Failed to submit inquiry.'));
    }
  } catch {
    alert(t('networkError', 'Network error occurred.'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ${escapeHtml(t('sendInquiryToStaff', 'Send Inquiry to Staff'))}`;
  }
});

// Quick chips click
document.querySelectorAll('.chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('ticket-subject').value = btn.textContent.trim();
  });
});

// Refresh button
document.getElementById('refresh-tickets-btn').addEventListener('click', loadMyTickets);

// Init
loadAuth();
