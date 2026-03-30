/**
 * SimpleTip shared navigation bar.
 * Include via <script src="nav.js"></script> at the top of <body>.
 * Injects a header bar with nav links + login/profile icon.
 */
(function () {
  'use strict';

  const API = '/simpletip/api';

  function getWallet() {
    try {
      const raw = localStorage.getItem('simpletip_wallet');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cents(v) { return '$' + (v / 100).toFixed(2); }

  // Determine current page for active state
  const path = window.location.pathname;
  const page = path.split('/').pop() || 'index.html';

  const links = [
    { href: 'index.html', label: 'Demo', match: ['index.html', ''] },
    { href: 'wallet.html', label: 'My Wallet', match: ['wallet.html'] },
    { href: 'setup.html', label: 'Receiver Setup', match: ['setup.html'] },
    { href: 'dashboard.html', label: 'Receiver Dashboard', match: ['dashboard.html'] },
    { href: 'profile.html', label: 'Profile', match: ['profile.html'] },
  ];

  // Build nav HTML
  const navLinksHtml = links.map(l => {
    const active = l.match.includes(page) ? ' st-nav-active' : '';
    return `<a href="${l.href}" class="st-nav-link${active}">${l.label}</a>`;
  }).join('');

  const w = getWallet();
  const isLoggedIn = w && w.token;

  let profileHtml;
  if (isLoggedIn) {
    const name = w.name || w.email || w.handle || '';
    const initial = (name[0] || '?').toUpperCase();
    const bal = typeof w.balance === 'number' ? cents(w.balance) : '';
    profileHtml = `
      <a href="profile.html" class="st-profile" title="Profile">
        <span class="st-profile-bal">${bal}</span>
        <span class="st-profile-avatar">${initial}</span>
      </a>
    `;
  } else {
    profileHtml = `
      <a href="login.html" class="st-login-link" title="Sign in">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Sign in</span>
      </a>
    `;
  }

  const bar = document.createElement('div');
  bar.className = 'st-navbar';
  bar.innerHTML = `
    <div class="st-navbar-inner">
      <a href="index.html" class="st-brand">SimpleTip</a>
      <div class="st-nav-links">${navLinksHtml}</div>
      <div class="st-nav-right">${profileHtml}</div>
    </div>
  `;

  // Inject CSS
  const style = document.createElement('style');
  style.textContent = `
    .st-navbar {
      background: #3f2534; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      position: sticky; top: 0; z-index: 1000; box-shadow: 0 1px 4px rgba(0,0,0,0.15);
    }
    .st-navbar-inner {
      max-width: 900px; margin: 0 auto; display: flex; align-items: center;
      padding: 0 16px; height: 48px; gap: 8px;
    }
    .st-brand {
      font-size: 1rem; font-weight: 700; color: #fff; text-decoration: none;
      margin-right: 16px; white-space: nowrap;
    }
    .st-brand:hover { color: #00b2e5; }
    .st-nav-links { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; overflow: hidden; }
    .st-nav-link {
      color: rgba(255,255,255,0.7); text-decoration: none; font-size: 0.78rem;
      padding: 4px 10px; border-radius: 4px; white-space: nowrap;
    }
    .st-nav-link:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .st-nav-link.st-nav-active { color: #fff; background: rgba(255,255,255,0.15); font-weight: 600; }
    .st-nav-right { margin-left: auto; flex-shrink: 0; }
    .st-login-link {
      display: flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.8);
      text-decoration: none; font-size: 0.8rem; padding: 4px 10px; border-radius: 6px;
    }
    .st-login-link:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .st-login-link svg { width: 18px; height: 18px; }
    .st-profile {
      display: flex; align-items: center; gap: 8px; text-decoration: none; color: #fff;
      padding: 3px 6px 3px 10px; border-radius: 6px;
    }
    .st-profile:hover { background: rgba(255,255,255,0.1); }
    .st-profile-bal { font-size: 0.78rem; font-weight: 600; color: #22c55e; }
    .st-profile-avatar {
      width: 28px; height: 28px; border-radius: 50%; background: #00b2e5; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 0.82rem; font-weight: 700;
    }
    @media (max-width: 600px) {
      .st-nav-links { display: none; }
      .st-navbar-inner { height: 44px; }
    }
  `;
  document.head.appendChild(style);

  // Insert at top of body
  document.body.insertBefore(bar, document.body.firstChild);

  // Listen for wallet updates (from fund popup, login popup, etc.)
  window.addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'simpletip-wallet-updated' || event.data.type === 'simpletip-auth')) {
      localStorage.setItem('simpletip_wallet', JSON.stringify(event.data.wallet));
      location.reload(); // Refresh nav state
    }
  });
})();
