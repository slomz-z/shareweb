
function t(key, fallback) {
  const lang = document.documentElement.getAttribute("lang") || "en";
  const dict = window.ShareWebI18n?.PAGE_TRANSLATIONS?.[lang] || window.ShareWebI18n?.PAGE_TRANSLATIONS?.["en"] || {};
  return dict[key] || fallback || key;
}

let currentUsers = [];
let currentUserRole = 'moderator';
let currentUserEmail = '';
let targetEmail = null;

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// 1. Fetch and render stats
async function loadStats() {
  try {
    const res = await fetch('/api/admin/stats');
    if (res.status === 401 || res.status === 403) {
      window.location.reload();
      return;
    }
    const data = await res.json();
    if (!data.ok) return;

    currentUserRole = data.user.role || 'moderator';
    currentUserEmail = (data.user.email || '').toLowerCase();
    document.getElementById('admin-name').textContent = data.user.name || data.user.email;
    document.getElementById('admin-role').textContent = currentUserRole.toUpperCase();



    const s = data.stats;
    document.getElementById('metric-users').textContent = s.totalUsers;
    document.getElementById('metric-blocked-users').textContent = `${s.blockedUsers} ${t('statusSuspended', 'suspended').toLowerCase()}`;
    document.getElementById('metric-sockets').textContent = s.connectedSockets;
    document.getElementById('metric-rooms').textContent = `${s.activeRooms} ${t('activeRooms', 'active rooms')}`;
    const bannedEmailsEl = document.getElementById('metric-banned-emails');
    if (bannedEmailsEl) bannedEmailsEl.textContent = s.bannedEmailsCount || 0;
    document.getElementById('metric-storage').textContent = formatBytes(s.totalStorageBytes);
    document.getElementById('metric-uptime').textContent = `${t('sysServerUptime', 'Uptime:').replace(':', '')}: ${formatUptime(s.uptimeSeconds)}`;

    // System tab
    document.getElementById('sys-node').textContent = s.nodeVersion;
    document.getElementById('sys-uptime').textContent = formatUptime(s.uptimeSeconds);
    document.getElementById('sys-memory').textContent = formatBytes(s.memory.rss);
    document.getElementById('sys-smtp').textContent = s.smtpConfigured ? t('enabledActive', 'Enabled (Active)') : t('disabled', 'Disabled');
    document.getElementById('sys-oauth').textContent = s.googleConfigured ? t('configured', 'Configured') : t('disabled', 'Disabled');
    document.getElementById('sys-uploads').textContent = formatBytes(s.uploadsStorageBytes);

    if (currentUserRole === 'owner') {
      document.querySelectorAll('.owner-only').forEach(el => el.classList.remove('hidden'));
    } else {
      document.querySelectorAll('.owner-only').forEach(el => el.classList.add('hidden'));
    }

    if (currentUsers.length > 0) {
      renderUsers();
    }
  } catch (err) {
    console.error('Failed to load stats', err);
  }
}

// 2. Fetch and render users
async function loadUsers() {
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!data.ok) return;
    currentUsers = data.users || [];
    renderUsers();
  } catch (err) {
    console.error('Failed to load users', err);
  }
}

function renderUsers() {
  const tbody = document.getElementById('users-table-body');
  const search = document.getElementById('user-search').value.toLowerCase().trim();
  const filter = document.getElementById('user-filter').value;

  const filtered = currentUsers.filter(u => {
    const matchSearch = u.name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search);
    if (!matchSearch) return false;
    if (filter === 'active') return !u.blocked;
    if (filter === 'blocked') return u.blocked;
    if (filter === 'admins') return u.role === 'owner' || u.role === 'moderator';
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(t('noUsersFound', 'No users found.'))}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    const init = (u.name || u.email || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    const avatarHtml = u.picture
      ? `<img src="${escapeHtml(u.picture)}" class="avatar" alt="" />`
      : `<div class="avatar initials" style="display:grid; place-items:center; background:#4a4ad9; color:#fff; font-weight:700; font-size:12px; border-radius:50%; width:32px; height:32px;">${escapeHtml(init)}</div>`;

    const rolePill = u.role === 'owner'
      ? `<span class="pill pill-owner">${escapeHtml(t('roleOwner', 'Owner'))}</span>`
      : u.role === 'moderator'
      ? `<span class="pill pill-moderator">${escapeHtml(t('roleModerator', 'Moderator'))}</span>`
      : `<span class="pill pill-user">${escapeHtml(t('roleUser', 'User'))}</span>`;

    const statusPill = u.blocked
      ? `<span class="pill pill-blocked" title="${escapeHtml(u.blockReason)}">${escapeHtml(t('statusSuspended', 'Suspended'))}</span>`
      : `<span class="pill pill-active">${escapeHtml(t('statusActive', 'Active'))}</span>`;

    const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
    const isSelf = (u.email && u.email.toLowerCase() === currentUserEmail) || u.email === 'slomzz2013@gmail.com';
    const isOwner = currentUserRole === 'owner';

    let actionBtns = '';
    if (u.blocked) {
      actionBtns += `<button class="action-btn success" data-action="unblock" data-email="${escapeHtml(u.email)}" data-i18n="actionRestore">${escapeHtml(t('actionRestore', 'Restore'))}</button> `;
    } else if (!isSelf) {
      actionBtns += `<button class="action-btn danger" data-action="block" data-email="${escapeHtml(u.email)}" data-i18n="actionSuspend">${escapeHtml(t('actionSuspend', 'Suspend'))}</button> `;
    }

    if (isOwner && !isSelf) {
      actionBtns += `<button class="action-btn" data-action="role" data-email="${escapeHtml(u.email)}" data-role="${escapeHtml(u.role || 'user')}" data-i18n="actionRole">${escapeHtml(t('actionRole', 'Role'))}</button> `;
      actionBtns += `<button class="action-btn danger" data-action="delete" data-email="${escapeHtml(u.email)}" data-i18n="actionDelete">${escapeHtml(t('actionDelete', 'Delete'))}</button>`;
    }

    return `<tr>
      <td>
        <div class="user-cell">
          ${avatarHtml}
          <div class="u-meta">
            <span class="u-name">${escapeHtml(u.name || u.email.split('@')[0])}</span>
            <span class="u-email">${escapeHtml(u.email)}</span>
          </div>
        </div>
      </td>
      <td>${u.auth === 'google' ? 'Google' : 'Email'}</td>
      <td>${rolePill}</td>
      <td>${statusPill}</td>
      <td>${u.sendCount} ${escapeHtml(t('tabSent', 'sent').toLowerCase())} &bull; ${u.recvCount} ${escapeHtml(t('tabReceived', 'recv').toLowerCase())} (${formatBytes(u.diskBytes)})</td>
      <td>${joined}</td>
      <td>${actionBtns || '<span style="color:#555;">—</span>'}</td>
    </tr>`;
  }).join('');
}

// 3. User Actions
window.openBlockModal = function(email) {
  targetEmail = email;
  document.getElementById('modal-block-text').textContent = `Suspend user account: ${email}?`;
  document.getElementById('modal-block-reason').value = '';
  document.getElementById('modal-block').classList.remove('hidden');
};

window.unblockUser = async function(email) {
  if (!confirm(`Restore access for ${email}?`)) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}/unblock`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      loadStats();
      loadUsers();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to restore user.');
    }
  } catch {
    alert('Network error.');
  }
};

window.openRoleModal = function(email, currentRole) {
  targetEmail = email;
  document.getElementById('modal-role-text').textContent = `Change role for ${email}:`;
  document.getElementById('modal-role-select').value = currentRole || 'user';
  document.getElementById('modal-role').classList.remove('hidden');
};

window.openDeleteModal = function(email) {
  targetEmail = email;
  document.getElementById('modal-delete-text').textContent = `Permanently delete account and all files for ${email}? This action cannot be undone.`;
  document.getElementById('modal-delete').classList.remove('hidden');
};

// Modal listeners
document.getElementById('modal-block-cancel').addEventListener('click', () => {
  document.getElementById('modal-block').classList.add('hidden');
});
document.getElementById('modal-block-confirm').addEventListener('click', async () => {
  if (!targetEmail) return;
  const reason = document.getElementById('modal-block-reason').value.trim();
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modal-block').classList.add('hidden');
      loadStats();
      loadUsers();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to suspend user.');
    }
  } catch {
    alert('Network error.');
  }
});

document.getElementById('modal-role-cancel').addEventListener('click', () => {
  document.getElementById('modal-role').classList.add('hidden');
});
document.getElementById('modal-role-confirm').addEventListener('click', async () => {
  if (!targetEmail) return;
  const role = document.getElementById('modal-role-select').value;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modal-role').classList.add('hidden');
      loadStats();
      loadUsers();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to update role.');
    }
  } catch {
    alert('Network error.');
  }
});

document.getElementById('modal-delete-cancel').addEventListener('click', () => {
  document.getElementById('modal-delete').classList.add('hidden');
});
document.getElementById('modal-delete-confirm').addEventListener('click', async () => {
  if (!targetEmail) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(targetEmail)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modal-delete').classList.add('hidden');
      loadStats();
      loadUsers();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to delete user.');
    }
  } catch {
    alert('Network error.');
  }
});

// Close modals when clicking backdrop
document.querySelectorAll('.admin-modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
});

// 4. Email Bans
let currentBannedEmails = [];

async function loadBannedEmails() {
  try {
    const res = await fetch('/api/admin/bans');
    const data = await res.json();
    const tbody = document.getElementById('bans-table-body');
    if (!tbody) return;
    const bans = data.bans || [];
    currentBannedEmails = bans;
    if (bans.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-row" data-i18n="noBannedEmails">${escapeHtml(t('noBannedEmails', 'No banned emails.'))}</td></tr>`;
      return;
    }
    tbody.innerHTML = bans.map(b => {
      const dt = b.bannedAt ? new Date(b.bannedAt).toLocaleString() : '—';
      return `<tr>
        <td><code>${escapeHtml(b.email)}</code></td>
        <td>${escapeHtml(b.reason || '—')}</td>
        <td>${escapeHtml(b.bannedBy || 'System')}</td>
        <td>${dt}</td>
        <td><button class="action-btn success" data-action="unban-email" data-email="${escapeHtml(b.email)}" data-i18n="actionUnban">${escapeHtml(t('actionUnban', 'Unban'))}</button></td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load banned emails', err);
  }
}

window.unbanEmail = async function(email) {
  if (!confirm(t('confirmUnbanEmail', `Unban email ${email}?`))) return;
  try {
    const res = await fetch('/api/admin/bans/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.ok) {
      loadStats();
      loadBannedEmails();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to unban email.');
    }
  } catch {
    alert('Network error.');
  }
};

const addEmailBanBtn = document.getElementById('add-email-ban-btn');
if (addEmailBanBtn) {
  addEmailBanBtn.addEventListener('click', () => {
    document.getElementById('modal-ban-email').value = '';
    document.getElementById('modal-ban-reason').value = '';
    document.getElementById('modal-ban').classList.remove('hidden');
  });
}
const modalBanCancel = document.getElementById('modal-ban-cancel');
if (modalBanCancel) {
  modalBanCancel.addEventListener('click', () => {
    document.getElementById('modal-ban').classList.add('hidden');
  });
}
const modalBanConfirm = document.getElementById('modal-ban-confirm');
if (modalBanConfirm) {
  modalBanConfirm.addEventListener('click', async () => {
    const email = document.getElementById('modal-ban-email').value.trim().toLowerCase();
    const reason = document.getElementById('modal-ban-reason').value.trim() || 'manual moderation';
    if (!email) return;
    try {
      const res = await fetch('/api/admin/bans/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, reason }),
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById('modal-ban').classList.add('hidden');
        loadStats();
        loadBannedEmails();
        loadAuditData();
      } else {
        alert(data.error || 'Failed to ban email.');
      }
    } catch {
      alert('Network error.');
    }
  });
}

// 5. Live Sockets & Rooms
async function loadLive() {
  try {
    const res = await fetch('/api/admin/rooms');
    const data = await res.json();
    if (!data.ok) return;

    document.getElementById('live-clients-count').textContent = data.clientsCount || 0;
    document.getElementById('live-rooms-count').textContent = data.roomsCount || 0;

    const clientsBody = document.getElementById('live-clients-body');
    const roomsBody = document.getElementById('live-rooms-body');

    if (!data.clients || data.clients.length === 0) {
      clientsBody.innerHTML = `<tr><td colspan="3" class="empty-row" data-i18n="noConnectedSockets">${escapeHtml(t('noConnectedSockets', 'No connected sockets.'))}</td></tr>`;
    } else {
      clientsBody.innerHTML = data.clients.map(c => `<tr>
        <td><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:12px; color:#888;">${escapeHtml(c.email)}</span></td>
        <td><code>${escapeHtml(c.network)}</code></td>
        <td>${c.room ? `<span class="pill pill-moderator">${escapeHtml(c.room)}</span>` : `<span style="color:#666;" data-i18n="lobby">${escapeHtml(t('lobby', 'Lobby'))}</span>`}</td>
      </tr>`).join('');
    }

    if (!data.rooms || data.rooms.length === 0) {
      roomsBody.innerHTML = `<tr><td colspan="3" class="empty-row" data-i18n="noActiveRooms">${escapeHtml(t('noActiveRooms', 'No active rooms.'))}</td></tr>`;
    } else {
      roomsBody.innerHTML = data.rooms.map(r => `<tr>
        <td><strong style="letter-spacing:1px; color:#a5b4fc;">${escapeHtml(r.code)}</strong></td>
        <td>${r.membersCount} ${escapeHtml(t('thMembers', 'members').toLowerCase())}</td>
        <td>${r.emptySince ? `<span class="pill pill-blocked" data-i18n="empty">${escapeHtml(t('empty', 'Empty'))}</span>` : `<span class="pill pill-active" data-i18n="statusActive">${escapeHtml(t('statusActive', 'Active'))}</span>`}</td>
      </tr>`).join('');
    }
  } catch (err) {
    console.error('Failed to load live data', err);
  }
}

// 6. Cleanup
document.getElementById('cleanup-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cleanup-btn');
  btn.disabled = true;
  btn.textContent = 'Cleaning...';
  try {
    const res = await fetch('/api/admin/system/cleanup', { method: 'POST' });
    const data = await res.json();
    alert(`Cleanup complete. Removed ${data.cleanedSessions || 0} orphaned sessions.`);
    loadStats();
    loadAuditData();
  } catch {
    alert('Cleanup request failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Buffer Cleanup';
  }
});

// Search & filter listeners
document.getElementById('user-search').addEventListener('input', renderUsers);
document.getElementById('user-filter').addEventListener('change', renderUsers);
document.getElementById('refresh-users-btn').addEventListener('click', loadUsers);

// Table Action Event Delegation (CSP-compliant)
const usersTbody = document.getElementById('users-table-body');
if (usersTbody) {
  usersTbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const email = btn.dataset.email;
    const role = btn.dataset.role;

    if (action === 'unblock') unblockUser(email);
    else if (action === 'block') openBlockModal(email);
    else if (action === 'role') openRoleModal(email, role);
    else if (action === 'delete') openDeleteModal(email);
  });
}

const bansTbody = document.getElementById('bans-table-body');
if (bansTbody) {
  bansTbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="unban-email"]');
    if (!btn) return;
    const email = btn.dataset.email;
    if (email) unbanEmail(email);
  });
}

// 5. Support Tickets Management
let currentSupportTickets = [];
let selectedSupportTicketId = null;
let currentSupportSubtab = 'active'; // 'active' | 'banned'

async function loadSupportTickets() {
  try {
    const res = await fetch('/api/admin/support/tickets');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    currentSupportTickets = data.tickets || [];

    // Calculate badges
    const activeOpen = currentSupportTickets.filter(ticket => !ticket.isBannedUser && ticket.status === 'open').length;
    const bannedOpen = currentSupportTickets.filter(ticket => ticket.isBannedUser && ticket.status === 'open').length;
    const totalOpen = activeOpen + bannedOpen;

    const mainBadge = document.getElementById('support-badge');
    if (mainBadge) {
      if (totalOpen > 0) {
        mainBadge.textContent = totalOpen;
        mainBadge.classList.remove('hidden');
      } else {
        mainBadge.classList.add('hidden');
      }
    }

    const activeBadge = document.getElementById('support-active-badge');
    if (activeBadge) {
      if (activeOpen > 0) {
        activeBadge.textContent = activeOpen;
        activeBadge.classList.remove('hidden');
      } else {
        activeBadge.classList.add('hidden');
      }
    }

    const bannedBadge = document.getElementById('support-banned-badge');
    if (bannedBadge) {
      if (bannedOpen > 0) {
        bannedBadge.textContent = bannedOpen;
        bannedBadge.classList.remove('hidden');
      } else {
        bannedBadge.classList.add('hidden');
      }
    }

    renderSupportTickets();
  } catch (err) {
    console.error('Failed to load support tickets', err);
  }
}

function renderSupportTickets() {
  const tbody = document.getElementById('support-table-body');
  if (!tbody) return;

  const filter = document.getElementById('support-filter')?.value || 'all';
  const search = document.getElementById('support-search')?.value.toLowerCase().trim() || '';

  const filtered = currentSupportTickets.filter(ticket => {
    // Sub-tab filter: Active vs Banned
    const matchSubtab = currentSupportSubtab === 'banned' ? Boolean(ticket.isBannedUser) : !ticket.isBannedUser;
    if (!matchSubtab) return false;

    if (filter !== 'all' && ticket.status !== filter) return false;
    if (search) {
      const matchEmail = (ticket.userEmail || '').toLowerCase().includes(search);
      const matchName = (ticket.userName || '').toLowerCase().includes(search);
      const matchSubject = (ticket.subject || '').toLowerCase().includes(search);
      if (!matchEmail && !matchName && !matchSubject) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const emptyKey = currentSupportSubtab === 'banned' ? 'noBannedInquiries' : 'noActiveInquiries';
    const emptyFallback = currentSupportSubtab === 'banned' ? 'No support inquiries from banned or suspended users.' : 'No support inquiries from active users.';
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row" data-i18n="${emptyKey}">${escapeHtml(t(emptyKey, emptyFallback))}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(ticket => {
    const init = (ticket.userName || ticket.userEmail || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    const avatarBg = ticket.isBannedUser ? '#ef4444' : '#6366f1';
    const avatarHtml = `<div class="avatar initials" style="display:grid; place-items:center; background:${avatarBg}; color:#fff; font-weight:700; font-size:11px; border-radius:50%; width:28px; height:28px;">${escapeHtml(init)}</div>`;

    const statusKey = ticket.status === 'resolved' ? 'statusResolved' : (ticket.status === 'in_progress' ? 'statusInProgress' : 'statusOpen');
    const statusFallback = ticket.status === 'resolved' ? 'Resolved' : (ticket.status === 'in_progress' ? 'In Progress' : 'Open');
    const statusPill = `<span class="pill ${ticket.status === 'resolved' ? 'pill-resolved' : (ticket.status === 'in_progress' ? 'pill-progress' : 'pill-open')}" data-i18n="${statusKey}">${escapeHtml(t(statusKey, statusFallback))}</span>`;

    const banTag = ticket.isBannedUser
      ? `<span class="pill pill-blocked" style="font-size:10px; margin-top:2px;" title="${escapeHtml(ticket.banReason || 'Banned')}">${escapeHtml(ticket.banReason || 'Suspended')}</span>`
      : '';

    const createdStr = new Date(ticket.createdAt).toLocaleDateString();
    const updatedStr = new Date(ticket.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `<tr>
      <td>
        <div class="user-cell">
          ${avatarHtml}
          <div class="u-meta">
            <span class="u-name">${escapeHtml(ticket.userName)}</span>
            <span class="u-email">${escapeHtml(ticket.userEmail)}</span>
            ${banTag}
          </div>
        </div>
      </td>
      <td><strong style="color:#e0e7ff;">${escapeHtml(ticket.subject)}</strong></td>
      <td>${statusPill}</td>
      <td>${ticket.messages.length} msg${ticket.messages.length === 1 ? '' : 's'}</td>
      <td style="font-size:12px; color:var(--text-muted);">${createdStr}</td>
      <td style="font-size:12px; color:var(--text-muted);">${updatedStr}</td>
      <td>
        <button class="action-btn" data-action="view-support" data-id="${escapeHtml(ticket.id)}" style="background:var(--accent); color:#fff;" data-i18n="viewAndReply">${escapeHtml(t('viewAndReply', 'View & Reply'))}</button>
      </td>
    </tr>`;
  }).join('');
}

function openSupportModal(ticketId) {
  const ticket = currentSupportTickets.find(ticket => ticket.id === ticketId);
  if (!ticket) return;
  selectedSupportTicketId = ticketId;

  document.getElementById('modal-support-subject').textContent = ticket.subject;
  document.getElementById('modal-support-meta').innerHTML = `User: <strong>${escapeHtml(ticket.userName)}</strong> (${escapeHtml(ticket.userEmail)})`;

  const statusBadge = document.getElementById('modal-support-status-badge');
  if (statusBadge) {
    statusBadge.className = 'pill ' + (ticket.status === 'resolved' ? 'pill-resolved' : (ticket.status === 'in_progress' ? 'pill-progress' : 'pill-open'));
    statusBadge.textContent = ticket.status === 'resolved' ? 'Resolved' : (ticket.status === 'in_progress' ? 'In Progress' : 'Open');
  }

  // Toggle Resolve / Reopen buttons based on status
  const resolveBtn = document.getElementById('modal-support-resolve');
  const reopenBtn = document.getElementById('modal-support-reopen');
  if (ticket.status === 'resolved') {
    resolveBtn?.classList.add('hidden');
    reopenBtn?.classList.remove('hidden');
  } else {
    resolveBtn?.classList.remove('hidden');
    reopenBtn?.classList.add('hidden');
  }

  // Banned alert in modal
  const banAlert = document.getElementById('modal-support-ban-alert');
  const banText = document.getElementById('modal-support-ban-text');
  if (banAlert && banText) {
    if (ticket.isBannedUser) {
      banText.textContent = `⚠️ This inquiry is from a restricted user (${ticket.banReason || 'Account suspended or IP blocked'}).`;
      banAlert.classList.remove('hidden');
    } else {
      banAlert.classList.add('hidden');
    }
  }

  const msgContainer = document.getElementById('modal-support-messages');
  if (msgContainer) {
    msgContainer.innerHTML = ticket.messages.map(m => {
      const isStaff = m.sender === 'moderator';
      const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div style="padding:10px 14px; border-radius:10px; font-size:13px; max-width:85%; word-break:break-word; align-self:${isStaff ? 'flex-end' : 'flex-start'}; background:${isStaff ? 'rgba(99,102,241,0.14)' : 'var(--card-bg-2)'}; border:1px solid ${isStaff ? 'rgba(99,102,241,0.35)' : 'var(--border-color)'}; color:var(--text);">
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px; font-weight:600; display:flex; justify-content:space-between; gap:12px;">
          <span style="color:${isStaff ? 'var(--accent)' : 'var(--text)'};">${escapeHtml(m.senderName)} (${isStaff ? 'Staff' : 'User'})</span>
          <span>${timeStr}</span>
        </div>
        <div style="white-space:pre-wrap; word-break:break-word; color:var(--text);">${escapeHtml(m.text)}</div>
      </div>`;
    }).join('');
    setTimeout(() => { msgContainer.scrollTop = msgContainer.scrollHeight; }, 50);
  }

  const replyInput = document.getElementById('modal-support-reply');
  if (replyInput) {
    replyInput.value = '';
    replyInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('modal-support-send')?.click();
      }
    };
  }

  document.getElementById('modal-support').classList.remove('hidden');
}

// Support table click delegation
const supportTbody = document.getElementById('support-table-body');
if (supportTbody) {
  supportTbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="view-support"]');
    if (!btn) return;
    openSupportModal(btn.dataset.id);
  });
}

// Modal Support Reply & Status Handlers
document.getElementById('modal-support-cancel')?.addEventListener('click', () => {
  document.getElementById('modal-support').classList.add('hidden');
});

document.getElementById('modal-support-send')?.addEventListener('click', async () => {
  if (!selectedSupportTicketId) return;
  const replyEl = document.getElementById('modal-support-reply');
  const text = replyEl ? replyEl.value.trim() : '';

  if (!text) {
    alert('Please enter a response message.');
    return;
  }

  const btn = document.getElementById('modal-support-send');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await fetch(`/api/admin/support/tickets/${encodeURIComponent(selectedSupportTicketId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('modal-support').classList.add('hidden');
      await loadSupportTickets();
      loadAuditData();
    } else {
      alert(data.error || 'Failed to send reply');
    }
  } catch {
    alert('Network error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Response';
  }
});

document.getElementById('modal-support-resolve')?.addEventListener('click', async () => {
  if (!selectedSupportTicketId) return;
  const btn = document.getElementById('modal-support-resolve');
  btn.disabled = true;
  btn.textContent = 'Resolving...';

  try {
    const replyEl = document.getElementById('modal-support-reply');
    const text = replyEl ? replyEl.value.trim() : '';

    if (text) {
      // Send message AND resolve
      await fetch(`/api/admin/support/tickets/${encodeURIComponent(selectedSupportTicketId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, resolve: true }),
      });
    } else {
      // Mark resolved directly
      await fetch(`/api/admin/support/tickets/${encodeURIComponent(selectedSupportTicketId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    }
    document.getElementById('modal-support').classList.add('hidden');
    await loadSupportTickets();
    loadAuditData();
  } catch {
    alert('Network error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Mark as Resolved';
  }
});

document.getElementById('modal-support-reopen')?.addEventListener('click', async () => {
  if (!selectedSupportTicketId) return;
  const btn = document.getElementById('modal-support-reopen');
  btn.disabled = true;
  btn.textContent = 'Reopening...';

  try {
    await fetch(`/api/admin/support/tickets/${encodeURIComponent(selectedSupportTicketId)}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    document.getElementById('modal-support').classList.add('hidden');
    await loadSupportTickets();
    loadAuditData();
  } catch {
    alert('Network error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reopen Ticket';
  }
});

// Search & filter support listeners
document.getElementById('support-search')?.addEventListener('input', renderSupportTickets);
document.getElementById('support-filter')?.addEventListener('change', renderSupportTickets);
document.getElementById('refresh-support-btn')?.addEventListener('click', loadSupportTickets);

// Subtabs switcher inside Support Tickets
document.querySelectorAll('.support-subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.support-subtab-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = 'var(--card-bg-2)';
      b.style.borderColor = 'var(--border-color)';
      b.style.color = b.dataset.subtab === 'banned' ? '#fca5a5' : 'var(--text-muted)';
    });
    btn.classList.add('active');
    if (btn.dataset.subtab === 'banned') {
      btn.style.background = 'rgba(239,68,68,0.15)';
      btn.style.borderColor = '#ef4444';
      btn.style.color = '#fca5a5';
    } else {
      btn.style.background = 'rgba(99,102,241,0.15)';
      btn.style.borderColor = 'var(--accent)';
      btn.style.color = '#fff';
    }
    currentSupportSubtab = btn.dataset.subtab;
    renderSupportTickets();
  });
});

// 5. Staff & Audit Log (Owner Only)
let currentStaff = [];
let currentAuditLogs = [];

async function loadAuditData() {
  if (currentUserRole !== 'owner') return;
  try {
    const res = await fetch('/api/admin/audit-log');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    currentStaff = data.staff || [];
    currentAuditLogs = data.logs || [];
    renderStaff();
    renderAuditLogs();
  } catch (err) {
    console.error('Failed to load audit data', err);
  }
}

function renderStaff() {
  const tbody = document.getElementById('staff-table-body');
  if (!tbody) return;
  if (currentStaff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row" data-i18n="noStaffFound">${escapeHtml(t('noStaffFound', 'No staff accounts found.'))}</td></tr>`;
    return;
  }

  tbody.innerHTML = currentStaff.map(s => {
    const init = (s.name || s.email || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    const avatarHtml = s.picture
      ? `<img src="${escapeHtml(s.picture)}" class="avatar" alt="" />`
      : `<div class="avatar initials" style="display:grid; place-items:center; background:#4a4ad9; color:#fff; font-weight:700; font-size:12px; border-radius:50%; width:32px; height:32px;">${escapeHtml(init)}</div>`;

    const rolePill = s.role === 'owner'
      ? `<span class="pill pill-owner">${escapeHtml(t('roleOwner', 'Owner'))}</span>`
      : `<span class="pill pill-moderator">${escapeHtml(t('roleModerator', 'Moderator'))}</span>`;

    const statusPill = s.blocked
      ? `<span class="pill pill-blocked" title="${escapeHtml(s.blockReason)}">Suspended</span>`
      : `<span class="pill pill-active">${escapeHtml(t('statusActive', 'Active'))}</span>`;

    const isSelf = (s.email && s.email.toLowerCase() === currentUserEmail) || s.email === 'slomzz2013@gmail.com';
    const lastActive = s.lastActionAt ? new Date(s.lastActionAt).toLocaleString() : 'No recent actions';

    let actionBtns = '';
    if (!isSelf && currentUserRole === 'owner') {
      actionBtns = `<button class="action-btn" data-action="role" data-email="${escapeHtml(s.email)}" data-role="${escapeHtml(s.role)}" data-i18n="changeRole">${escapeHtml(t('changeRole', 'Change Role'))}</button>`;
    } else {
      actionBtns = '<span style="color:#555;">—</span>';
    }

    return `<tr>
      <td>
        <div class="user-cell">
          ${avatarHtml}
          <div class="u-meta">
            <span class="u-name">${escapeHtml(s.name || s.email.split('@')[0])}</span>
            <span class="u-email">${escapeHtml(s.email)}</span>
          </div>
        </div>
      </td>
      <td>${rolePill}</td>
      <td><strong>${s.actionCount || 0}</strong> actions</td>
      <td style="font-size:12.5px; color:#cbd5e1;">${lastActive}</td>
      <td>${statusPill}</td>
      <td>${actionBtns}</td>
    </tr>`;
  }).join('');
}

function renderAuditLogs() {
  const tbody = document.getElementById('audit-table-body');
  if (!tbody) return;
  const filter = document.getElementById('audit-filter-action')?.value || 'all';
  const search = document.getElementById('audit-search')?.value.toLowerCase().trim() || '';

  const filtered = currentAuditLogs.filter(log => {
    if (filter !== 'all' && log.action !== filter) return false;
    if (search) {
      const actorMatch = (log.actorEmail || '').toLowerCase().includes(search) || (log.actorName || '').toLowerCase().includes(search);
      const targetMatch = (log.target || '').toLowerCase().includes(search);
      const detailsMatch = (log.details || '').toLowerCase().includes(search);
      const actionMatch = (log.action || '').toLowerCase().includes(search);
      if (!actorMatch && !targetMatch && !detailsMatch && !actionMatch) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row" data-i18n="noAuditLogs">${escapeHtml(t('noAuditLogs', 'No audit logs matching criteria.'))}</td></tr>`;
    return;
  }

  const actionBadges = {
    SUSPEND_USER: `<span class="badge-action badge-suspend" data-i18n="filterActionSuspend">${escapeHtml(t('filterActionSuspend', 'Suspended User'))}</span>`,
    RESTORE_USER: `<span class="badge-action badge-restore" data-i18n="filterActionRestore">${escapeHtml(t('filterActionRestore', 'Restored User'))}</span>`,
    CHANGE_ROLE: `<span class="badge-action badge-role" data-i18n="filterActionRole">${escapeHtml(t('filterActionRole', 'Changed Role'))}</span>`,
    DELETE_USER: `<span class="badge-action badge-delete" data-i18n="filterActionDelete">${escapeHtml(t('filterActionDelete', 'Deleted Account'))}</span>`,
    BAN_EMAIL: `<span class="badge-action badge-suspend" data-i18n="filterActionBanEmail">${escapeHtml(t('filterActionBanEmail', 'Banned Email'))}</span>`,
    UNBAN_EMAIL: `<span class="badge-action badge-restore" data-i18n="filterActionUnbanEmail">${escapeHtml(t('filterActionUnbanEmail', 'Unbanned Email'))}</span>`,
    BUFFER_CLEANUP: `<span class="badge-action badge-cleanup" data-i18n="filterActionCleanup">${escapeHtml(t('filterActionCleanup', 'Buffer Cleanup'))}</span>`,
  };

  tbody.innerHTML = filtered.map(log => {
    const badge = actionBadges[log.action] || `<span class="badge-action badge-cleanup">${escapeHtml(log.action)}</span>`;
    const dt = new Date(log.timestamp);
    const dateStr = dt.toLocaleDateString();
    const timeStr = dt.toLocaleTimeString();

    return `<tr>
      <td style="white-space:nowrap;">
        <div style="font-weight:600; font-size:12px;">${timeStr}</div>
        <div style="font-size:11px; color:var(--text-muted);">${dateStr}</div>
      </td>
      <td>
        <div style="display:flex; flex-direction:column;">
          <span style="font-weight:600; font-size:13px;">${escapeHtml(log.actorName || log.actorEmail)}</span>
          <span style="font-size:11.5px; color:var(--text-muted);">${escapeHtml(log.actorEmail)} <span class="pill ${log.actorRole === 'owner' ? 'pill-owner' : 'pill-moderator'}" style="font-size:10px; padding:1px 5px; margin-left:4px;">${escapeHtml(log.actorRole || 'staff')}</span></span>
        </div>
      </td>
      <td>${badge}</td>
      <td><code>${escapeHtml(log.target)}</code></td>
      <td style="max-width:320px; word-break:break-word; color:#cbd5e1; font-size:12.5px;">${escapeHtml(log.details || '—')}</td>
    </tr>`;
  }).join('');
}

// Staff table delegation
const staffTbody = document.getElementById('staff-table-body');
if (staffTbody) {
  staffTbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="role"]');
    if (!btn) return;
    openRoleModal(btn.dataset.email, btn.dataset.role);
  });
}

// Audit filter & search listeners
const auditSearch = document.getElementById('audit-search');
if (auditSearch) auditSearch.addEventListener('input', renderAuditLogs);

const auditFilter = document.getElementById('audit-filter-action');
if (auditFilter) auditFilter.addEventListener('change', renderAuditLogs);

const auditRefreshBtn = document.getElementById('refresh-audit-btn');
if (auditRefreshBtn) auditRefreshBtn.addEventListener('click', loadAuditData);

// Tab switching
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(tabEl => tabEl.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(`tab-${tab.dataset.tab}`);
    if (target) target.classList.add('active');

    if (tab.dataset.tab === 'support') loadSupportTickets();
    if (tab.dataset.tab === 'bans') loadBannedEmails();
    if (tab.dataset.tab === 'live') loadLive();
    if (tab.dataset.tab === 'audit') loadAuditData();
  });
});

// Init
async function initAdmin() {
  if (window.ShareWebI18n?.initPageI18n) {
    try { await window.ShareWebI18n.initPageI18n(); } catch {}
  }
  try {
    await Promise.all([loadStats(), loadUsers(), loadSupportTickets()]);
  } catch {}

  const adminImages = Array.from(document.querySelectorAll('.avatar img, img.avatar') || []);
  if (window.ShareWebLoader && typeof window.ShareWebLoader.whenReady === 'function') {
    window.ShareWebLoader.whenReady({
      waitForFonts: true,
      waitForLanguage: true,
      images: adminImages
    });
  } else if (window.hidePageLoader) {
    window.hidePageLoader();
  }
}
initAdmin();

window.addEventListener('shareweb:languageChanged', () => {
  loadStats();
  if (currentUsers.length > 0) renderUsers();
  if (currentSupportTickets.length > 0) renderSupportTickets();
  if (currentStaff.length > 0) renderStaff();
  if (currentAuditLogs.length > 0) renderAuditLogs();
});
setInterval(() => {
  loadStats();
  const activeTab = document.querySelector('.admin-tab.active')?.dataset.tab;
  if (activeTab === 'support') loadSupportTickets();
  if (activeTab === 'bans') loadBannedEmails();
  if (activeTab === 'live') loadLive();
  if (activeTab === 'audit') loadAuditData();
}, 10000);

// Live Telemetry Sparkline
const telemetryHistory = [];
const maxTelemetryPoints = 40;

function drawSparkline() {
  const canvas = document.getElementById('telemetry-sparkline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  if (telemetryHistory.length < 2) return;

  const maxVal = Math.max(5, ...telemetryHistory.map(p => p.clientsCount + p.roomsCount));

  ctx.beginPath();
  const step = w / (maxTelemetryPoints - 1);
  const offset = maxTelemetryPoints - telemetryHistory.length;

  telemetryHistory.forEach((pt, idx) => {
    const val = pt.clientsCount + pt.roomsCount;
    const x = (offset + idx) * step;
    const y = h - (val / maxVal) * (h - 12) - 6;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Gradient fill
  const lastX = (offset + telemetryHistory.length - 1) * step;
  ctx.lineTo(lastX, h);
  ctx.lineTo(offset * step, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
  grad.addColorStop(1, 'rgba(99, 102, 241, 0.0)');
  ctx.fillStyle = grad;
  ctx.fill();
}

async function pollTelemetry() {
  try {
    const res = await fetch('/api/admin/telemetry');
    if (res.ok) {
      const d = await res.json();
      telemetryHistory.push(d);
      if (telemetryHistory.length > maxTelemetryPoints) telemetryHistory.shift();
      drawSparkline();
      const rateEl = document.getElementById('telemetry-rate');
      if (rateEl) {
        rateEl.textContent = `${t('telemetryLive', 'Live')}: ${d.clientsCount} ${t('thClient', 'socket')}${d.clientsCount === 1 ? '' : 's'} · ${d.roomsCount} ${t('thRoom', 'room')}${d.roomsCount === 1 ? '' : 's'} · ${t('heap', 'Heap')}: ${formatBytes(d.heapUsed)}`;
      }
    }
  } catch {}
}

setInterval(pollTelemetry, 1000);
pollTelemetry();
