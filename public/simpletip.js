/**
 * SimpleTip — embeddable tipping web component
 *
 * <simple-tip author="james-okafor" author-name="James Okafor"></simple-tip>
 *
 * Three states:
 *   1. Logged in + has balance → Tip buttons (one click, green flash)
 *   2. Logged in + no balance  → Pledge buttons (records intent, prompts to fund)
 *   3. Not logged in           → Pledge buttons → opens login popup on click
 */
(function () {
  'use strict';

  const API = (document.currentScript && document.currentScript.dataset.api)
    || 'https://demos.linkedtrust.us/simpletip/api';
  const BASE_URL = API.replace('/api', '');

  const BRAND = '#3f2534';
  const ACCENT = '#00b2e5';
  const GREEN = '#22c55e';
  const GREEN_DARK = '#16a34a';
  const PINK = '#ff6872';
  const GOLD = '#f59e0b';
  const BLUE_SKY = '#0085ff';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ── Wallet (localStorage + API sync) ──────────────────────

  function getWallet() {
    try {
      const raw = localStorage.getItem('simpletip_wallet');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveWallet(w) {
    try { localStorage.setItem('simpletip_wallet', JSON.stringify(w)); } catch (e) {}
  }

  function clearWallet() {
    try { localStorage.removeItem('simpletip_wallet'); } catch (e) {}
  }

  // ── API helpers ───────────────────────────────────────────

  async function apiPost(path, body) {
    const wallet = getWallet();
    const headers = { 'Content-Type': 'application/json' };
    if (wallet && wallet.token) headers['Authorization'] = `Bearer ${wallet.token}`;
    const resp = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return resp.json();
  }

  async function apiGet(path) {
    const wallet = getWallet();
    const headers = {};
    if (wallet && wallet.token) headers['Authorization'] = `Bearer ${wallet.token}`;
    const resp = await fetch(`${API}${path}`, { headers });
    return resp.json();
  }

  // ── <simple-tip> ──────────────────────────────────────────

  class SimpleTip extends HTMLElement {
    connectedCallback() {
      const author = this.getAttribute('author') || '';
      const authorName = this.getAttribute('author-name') || author;
      const authorImg = this.getAttribute('author-img') || '';
      const subject = this.getAttribute('subject') || '';
      const subjectName = this.getAttribute('subject-label') || subject;
      const subjectImg = this.getAttribute('subject-img') || '';
      const defaultAmounts = (this.getAttribute('amounts') || '1,3,5').split(',').map(Number);
      const isSplit = !!subject;

      const shadow = this.attachShadow({ mode: 'open' });

      shadow.innerHTML = `
        <style>
          :host { display: block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }

          .tip-bar {
            display: flex; align-items: center; gap: 10px;
            background: ${BRAND}; color: #fff; border-radius: 10px;
            padding: 10px 16px; min-height: 48px;
            transition: background 0.3s ease;
          }
          .tip-bar.success { background: ${GREEN_DARK}; }
          .tip-bar.needs-funds { background: ${GOLD}; }
          .tip-bar.pledged { background: ${BLUE_SKY}; }

          .avatar {
            width: 36px; height: 36px; border-radius: 50%; object-fit: cover;
            border: 2px solid ${ACCENT}; flex-shrink: 0;
          }

          .info { flex: 1; min-width: 0; }
          .info .who {
            font-size: 0.8rem; font-weight: 600; white-space: nowrap;
            overflow: hidden; text-overflow: ellipsis;
          }
          .info .sub { font-size: 0.65rem; opacity: 0.6; }

          .amounts { display: flex; gap: 6px; flex-shrink: 0; }
          .amt {
            background: ${ACCENT}; color: #fff; border: none; border-radius: 6px;
            padding: 6px 12px; font-size: 0.82rem; font-weight: 600; cursor: pointer;
            transition: all 0.15s;
          }
          .amt:hover { background: #0090c0; transform: scale(1.05); }
          .amt:active { transform: scale(0.95); }
          .amt:disabled { opacity: 0.5; cursor: default; transform: none; }
          /* Pledge style — slightly different look */
          .amt.pledge-mode { background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); }
          .amt.pledge-mode:hover { background: rgba(255,255,255,0.3); }

          .success-msg {
            display: none; font-size: 0.82rem; font-weight: 600;
            align-items: center; gap: 6px;
          }
          .success-msg.show { display: flex; }
          .amounts.hide { display: none; }

          .split-row {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 16px 8px; background: rgba(63,37,52,0.06);
            border-radius: 0 0 10px 10px; font-size: 0.75rem; color: #555;
          }
          .split-row input[type=range] { flex: 1; accent-color: ${ACCENT}; height: 4px; }
          .split-pct { font-weight: 600; min-width: 28px; text-align: center; font-size: 0.72rem; }
          .split-label { font-size: 0.68rem; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

          .footer {
            display: flex; align-items: center; gap: 6px; font-size: 0.6rem;
            opacity: 0.35; padding: 3px 16px 0; justify-content: flex-end;
          }
          .footer a { color: inherit; text-decoration: none; }
          .footer a:hover { opacity: 0.7; }

          .wallet-hint {
            display: none; font-size: 0.72rem; padding: 8px 16px;
            background: rgba(245,158,11,0.1); border-radius: 0 0 10px 10px;
            color: #92400e; text-align: center;
          }
          .wallet-hint.show { display: block; }
          .wallet-hint a { color: ${ACCENT}; cursor: pointer; text-decoration: underline; }

          .bal-badge {
            display: none; font-size: 0.68rem; font-weight: 600;
            background: rgba(255,255,255,0.15); padding: 3px 8px;
            border-radius: 4px; white-space: nowrap; flex-shrink: 0;
            cursor: pointer;
          }
          .bal-badge.show { display: block; }
          .bal-badge:hover { background: rgba(255,255,255,0.25); }
        </style>

        <div class="tip-bar" id="bar">
          ${authorImg ? `<img class="avatar" src="${esc(authorImg)}" alt="${esc(authorName)}">` : ''}
          <div class="info">
            <div class="who" id="whoLabel">Tip ${esc(authorName)}${isSplit ? ' + ' + esc(subjectName) : ''}</div>
            <div class="sub" id="subLabel">powered by SimpleTip</div>
          </div>
          <div class="bal-badge" id="balBadge" title="Your wallet balance"></div>
          <div class="amounts" id="amounts">
            ${defaultAmounts.map(a => `<button class="amt" data-amount="${a}">$${a}</button>`).join('')}
          </div>
          <div class="success-msg" id="successMsg">
            <span>&#10003;</span> <span id="successText">Sent!</span>
          </div>
        </div>
        ${isSplit ? `
        <div class="split-row" id="splitRow">
          <span class="split-label">${esc(authorName)}</span>
          <span class="split-pct" id="authorPct">50%</span>
          <input type="range" id="slider" min="10" max="90" value="50" step="10">
          <span class="split-pct" id="subjectPct">50%</span>
          <span class="split-label">${esc(subjectName)}</span>
        </div>` : ''}
        <div class="wallet-hint" id="walletHint">
          <span id="hintText"><a id="addFundsLink">Add funds</a> to your wallet to tip with one click.</span>
        </div>
        <div class="footer">
          <a href="https://linkedtrust.us" target="_blank">SimpleTip by LinkedTrust</a>
        </div>
      `;

      const bar = shadow.getElementById('bar');
      const amountsDiv = shadow.getElementById('amounts');
      const successMsg = shadow.getElementById('successMsg');
      const successText = shadow.getElementById('successText');
      const walletHint = shadow.getElementById('walletHint');
      const hintText = shadow.getElementById('hintText');
      const whoLabel = shadow.getElementById('whoLabel');
      const subLabel = shadow.getElementById('subLabel');
      const slider = shadow.getElementById('slider');
      const authorPct = shadow.getElementById('authorPct');
      const subjectPct = shadow.getElementById('subjectPct');
      const addFundsLink = shadow.getElementById('addFundsLink');
      const balBadge = shadow.getElementById('balBadge');
      const allBtns = shadow.querySelectorAll('.amt');

      // ── State management ──────────────────────────────────

      const _updateState = () => {
        const w = getWallet();
        const hasFunds = w && w.token && w.balance > 0;
        const isLoggedIn = w && w.token;

        // Balance badge
        if (isLoggedIn) {
          balBadge.textContent = `$${(w.balance || 0).toFixed(2)}`;
          balBadge.classList.add('show');
        } else {
          balBadge.classList.remove('show');
        }

        // Button mode
        if (hasFunds) {
          // State 1: Tip mode
          whoLabel.textContent = `Tip ${authorName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = 'powered by SimpleTip';
          allBtns.forEach(b => b.classList.remove('pledge-mode'));
        } else if (isLoggedIn) {
          // State 2: Pledge mode (logged in, no balance)
          whoLabel.textContent = `Pledge to ${authorName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = 'fund your wallet later to send';
          allBtns.forEach(b => b.classList.add('pledge-mode'));
        } else {
          // State 3: Not logged in — pledge mode, login on click
          whoLabel.textContent = `Pledge to ${authorName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = 'sign in to track your pledges';
          allBtns.forEach(b => b.classList.add('pledge-mode'));
        }
      };
      _updateState();

      // Clicking balance opens fund page
      balBadge.addEventListener('click', () => this._openFundingPopup());

      // Listen for auth/wallet updates from popups
      window.addEventListener('message', (event) => {
        if (event.data && (event.data.type === 'simpletip-wallet-updated' || event.data.type === 'simpletip-auth')) {
          saveWallet(event.data.wallet);
          _updateState();
        }
      });

      // Update after tips
      this.addEventListener('tip', () => setTimeout(_updateState, 100));
      this.addEventListener('pledge', () => setTimeout(_updateState, 100));

      // Slider
      if (slider) {
        slider.addEventListener('input', () => {
          const v = parseInt(slider.value);
          authorPct.textContent = v + '%';
          subjectPct.textContent = (100 - v) + '%';
        });
      }

      // Add funds link
      if (addFundsLink) {
        addFundsLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openFundingPopup();
        });
      }

      // Amount buttons — behavior depends on state
      allBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const amount = parseFloat(btn.dataset.amount);
          const splitPct = slider ? parseInt(slider.value) : 100;
          const wallet = getWallet();

          if (wallet && wallet.token && wallet.balance >= amount) {
            // State 1: Tip from balance
            this._handleTip(btn, {
              author, authorName, subject, subjectName, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns,
              _updateState,
            });
          } else if (wallet && wallet.token) {
            // State 2: Pledge (logged in, insufficient funds)
            this._handlePledge(btn, {
              author, authorName, subject, subjectName, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns,
              _updateState,
            });
          } else {
            // State 3: Not logged in — open login, then pledge
            this._handleLoginThenPledge(btn, {
              author, authorName, subject, subjectName, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns,
              _updateState,
            });
          }
        });
      });
    }

    // ── State 1: Tip from wallet balance ──────────────────

    async _handleTip(btn, ctx) {
      const { author, subject, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns,
              _updateState } = ctx;

      allBtns.forEach(b => b.disabled = true);
      btn.textContent = '...';

      try {
        const result = await apiPost('/tip', {
          author,
          subject: subject || undefined,
          amount,
          splitPct: subject ? splitPct : undefined,
        });

        if (result.success) {
          const wallet = getWallet();
          if (wallet) { wallet.balance = result.balance; saveWallet(wallet); }
          this._showFlash(bar, amountsDiv, successMsg, successText, `$${amount} sent!`, 'success', allBtns, btn, amount, _updateState);
          this.dispatchEvent(new CustomEvent('tip', { bubbles: true, detail: { amount } }));
          return;
        }

        if (result.error === 'insufficient_funds') {
          // Switch to pledge
          this._handlePledge(btn, ctx);
          return;
        }
      } catch (err) {
        console.error('SimpleTip error:', err);
      }
      allBtns.forEach(b => b.disabled = false);
      btn.textContent = `$${amount}`;
    }

    // ── State 2: Pledge (logged in, no/insufficient balance) ──

    async _handlePledge(btn, ctx) {
      const { author, subject, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns,
              _updateState } = ctx;

      allBtns.forEach(b => b.disabled = true);
      btn.textContent = '...';

      try {
        const result = await apiPost('/pledge', {
          author,
          subject: subject || undefined,
          amount,
          splitPct: subject ? splitPct : undefined,
        });

        if (result.success) {
          const msg = result.pendingTotal > amount
            ? `Pledged $${amount}! ($${result.pendingTotal.toFixed(2)} total)`
            : `Pledged $${amount}!`;
          this._showFlash(bar, amountsDiv, successMsg, successText, msg, 'pledged', allBtns, btn, amount, _updateState);

          // Show fund prompt if pledges are piling up
          if (result.pendingTotal >= 5) {
            setTimeout(() => {
              hintText.innerHTML = `You've pledged $${result.pendingTotal.toFixed(2)}. <a id="fundNowLink">Fund your wallet</a> to send it!`;
              walletHint.classList.add('show');
              const fundLink = hintText.querySelector('#fundNowLink');
              if (fundLink) fundLink.addEventListener('click', (e) => { e.preventDefault(); this._openFundingPopup(); });
            }, 2600);
          }

          this.dispatchEvent(new CustomEvent('pledge', { bubbles: true, detail: { amount, pendingTotal: result.pendingTotal } }));
          return;
        }
      } catch (err) {
        console.error('SimpleTip pledge error:', err);
      }
      allBtns.forEach(b => b.disabled = false);
      btn.textContent = `$${amount}`;
    }

    // ── State 3: Not logged in — login popup, then pledge ──

    _handleLoginThenPledge(btn, ctx) {
      const { amount, allBtns, _updateState } = ctx;

      // Open login popup
      const popup = window.open(`${BASE_URL}/login.html`, 'simpletip-login',
        'width=400,height=500,scrollbars=yes');

      // Listen for auth completion
      const msgHandler = (event) => {
        if (event.data && event.data.type === 'simpletip-auth') {
          window.removeEventListener('message', msgHandler);
          saveWallet(event.data.wallet);
          _updateState();
          if (popup && !popup.closed) popup.close();
          // Now create the pledge
          this._handlePledge(btn, ctx);
        }
      };
      window.addEventListener('message', msgHandler);
    }

    // ── Flash animation (tip or pledge) ─────────────────────

    _showFlash(bar, amountsDiv, successMsg, successText, text, cssClass, allBtns, btn, amount, _updateState) {
      bar.classList.add(cssClass);
      amountsDiv.classList.add('hide');
      successText.textContent = text;
      successMsg.classList.add('show');

      setTimeout(() => {
        bar.classList.remove(cssClass);
        amountsDiv.classList.remove('hide');
        successMsg.classList.remove('show');
        allBtns.forEach(b => b.disabled = false);
        btn.textContent = `$${amount}`;
        _updateState();
      }, 2500);
    }

    _openFundingPopup() {
      const w = window.open(`${BASE_URL}/fund.html`, 'simpletip-fund',
        'width=420,height=550,scrollbars=yes');

      const msgHandler = (event) => {
        if (event.data && event.data.type === 'simpletip-wallet-updated') {
          saveWallet(event.data.wallet);
          window.removeEventListener('message', msgHandler);
          if (w && !w.closed) w.close();
        }
      };
      window.addEventListener('message', msgHandler);
    }
  }

  // ── <simple-tip-setup> — author registration widget ───────

  class SimpleTipSetup extends HTMLElement {
    connectedCallback() {
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { display: block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          .setup {
            background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
            padding: 24px; max-width: 480px;
          }
          h2 { font-size: 1.1rem; color: ${BRAND}; margin-bottom: 12px; }
          p { font-size: 0.85rem; color: #666; margin-bottom: 16px; line-height: 1.4; }
          label { display: block; font-size: 0.82rem; color: #444; margin: 12px 0 4px; }
          input, select {
            width: 100%; padding: 10px 12px; border: 1px solid #d1d5db;
            border-radius: 6px; font-size: 0.88rem; background: #fafafa;
          }
          input:focus, select:focus { outline: none; border-color: ${ACCENT}; }
          .btn {
            display: block; width: 100%; padding: 12px; margin-top: 16px;
            background: ${ACCENT}; color: #fff; border: none; border-radius: 8px;
            font-size: 0.95rem; font-weight: 600; cursor: pointer;
          }
          .btn:hover { background: #0090c0; }
          .btn:disabled { opacity: 0.5; }
          .embed-code {
            display: none; background: #1a1a2e; color: ${GREEN}; padding: 14px;
            border-radius: 8px; font-family: monospace; font-size: 0.78rem;
            white-space: pre-wrap; margin-top: 16px; word-break: break-all;
          }
          .embed-code.show { display: block; }
          .result { display: none; }
          .result.show { display: block; }
          .result h3 { color: ${GREEN_DARK}; font-size: 1rem; margin-bottom: 8px; }
        </style>

        <div class="setup">
          <h2>Set up tipping for your content</h2>
          <p>Get an embeddable tip widget for your blog, newsletter, or website. Readers tip you with one click.</p>

          <div id="formSection">
            <label>Your name (as readers will see it)</label>
            <input type="text" id="nameInput" placeholder="James Okafor">

            <label>Email</label>
            <input type="email" id="emailInput" placeholder="you@example.com">

            <label>How do you want to get paid?</label>
            <select id="payoutMethod">
              <option value="paypal">PayPal</option>
              <option value="venmo">Venmo</option>
              <option value="zelle">Zelle</option>
              <option value="cashapp">Cash App</option>
              <option value="bank">Bank transfer (ACH)</option>
              <option value="mpesa">M-Pesa</option>
              <option value="usdt">USDT (crypto)</option>
              <option value="other">Other (tell us)</option>
            </select>

            <label>Payout address (email, phone, handle, or account)</label>
            <input type="text" id="payoutAddr" placeholder="your@paypal.com or +254...">

            <button class="btn" id="registerBtn">Get your embed code</button>
          </div>

          <div class="result" id="result">
            <h3>&#10003; You're set up!</h3>
            <p>Copy this code and paste it into your blog template, after each article, or in a custom HTML block:</p>
            <div class="embed-code show" id="embedCode"></div>
          </div>
        </div>
      `;

      const registerBtn = shadow.getElementById('registerBtn');
      const formSection = shadow.getElementById('formSection');
      const result = shadow.getElementById('result');
      const embedCode = shadow.getElementById('embedCode');

      registerBtn.addEventListener('click', async () => {
        const name = shadow.getElementById('nameInput').value.trim();
        const email = shadow.getElementById('emailInput').value.trim();
        const method = shadow.getElementById('payoutMethod').value;
        const addr = shadow.getElementById('payoutAddr').value.trim();

        if (!name || !email) return;

        registerBtn.disabled = true;
        registerBtn.textContent = 'Setting up...';

        try {
          const resp = await apiPost('/author/register', { name, email, payoutMethod: method, payoutAddress: addr });

          if (resp.slug) {
            embedCode.textContent =
              `<script src="${BASE_URL}/simpletip.js"><\/script>\n<simple-tip author="${resp.slug}" author-name="${esc(name)}"></simple-tip>`;
            formSection.style.display = 'none';
            result.classList.add('show');
          }
        } catch (err) {
          registerBtn.disabled = false;
          registerBtn.textContent = 'Get your embed code';
        }
      });
    }
  }

  customElements.define('simple-tip', SimpleTip);
  customElements.define('simple-tip-setup', SimpleTipSetup);
})();
