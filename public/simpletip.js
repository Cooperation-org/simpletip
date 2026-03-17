/**
 * SimpleTip — embeddable tipping web component
 *
 * <simple-tip author="james-okafor" author-name="James Okafor"></simple-tip>
 *
 * One click to tip. No page navigation. No popups (unless wallet empty).
 * Color flash confirms the tip inline.
 */
(function () {
  'use strict';

  const API = (document.currentScript && document.currentScript.dataset.api)
    || 'https://demos.linkedtrust.us/simpletip/api';

  const BRAND = '#3f2534';
  const ACCENT = '#00b2e5';
  const GREEN = '#22c55e';
  const GREEN_DARK = '#16a34a';
  const PINK = '#ff6872';
  const GOLD = '#f59e0b';

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

          .avatar {
            width: 36px; height: 36px; border-radius: 50%; object-fit: cover;
            border: 2px solid ${ACCENT}; flex-shrink: 0;
          }
          .avatar.subject-avatar { border-color: ${PINK}; }

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
            position: relative;
          }
          .amt:hover { background: #0090c0; transform: scale(1.05); }
          .amt:active { transform: scale(0.95); }
          .amt:disabled { opacity: 0.5; cursor: default; transform: none; }

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
        </style>

        <div class="tip-bar" id="bar">
          ${authorImg ? `<img class="avatar" src="${esc(authorImg)}" alt="${esc(authorName)}">` : ''}
          <div class="info">
            <div class="who">Tip ${esc(authorName)}${isSplit ? ' + ' + esc(subjectName) : ''}</div>
            <div class="sub">powered by SimpleTip</div>
          </div>
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
          Your wallet is empty. <a id="addFundsLink">Add funds</a> to tip with one click.
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
      const slider = shadow.getElementById('slider');
      const authorPct = shadow.getElementById('authorPct');
      const subjectPct = shadow.getElementById('subjectPct');
      const addFundsLink = shadow.getElementById('addFundsLink');

      // Slider
      if (slider) {
        slider.addEventListener('input', () => {
          const v = parseInt(slider.value);
          authorPct.textContent = v + '%';
          subjectPct.textContent = (100 - v) + '%';
        });
      }

      // Add funds link → open auth/fund popup
      if (addFundsLink) {
        addFundsLink.addEventListener('click', (e) => {
          e.preventDefault();
          this._openFundingPopup(author);
        });
      }

      // Tip buttons
      shadow.querySelectorAll('.amt').forEach(btn => {
        btn.addEventListener('click', () => this._handleTip(btn, {
          author, authorName, subject, subjectName,
          amount: parseFloat(btn.dataset.amount),
          splitPct: slider ? parseInt(slider.value) : 100,
          bar, amountsDiv, successMsg, successText, walletHint,
        }));
      });
    }

    async _handleTip(btn, ctx) {
      const { author, authorName, subject, subjectName, amount, splitPct,
              bar, amountsDiv, successMsg, successText, walletHint } = ctx;

      // Disable all buttons immediately
      const allBtns = bar.querySelectorAll('.amt');
      allBtns.forEach(b => b.disabled = true);
      btn.textContent = '...';

      const wallet = getWallet();

      try {
        if (wallet && wallet.token) {
          // Has wallet — try one-click tip from balance
          const result = await apiPost('/tip', {
            author,
            subject: subject || undefined,
            amount,
            splitPct: subject ? splitPct : undefined,
          });

          if (result.success) {
            // Update local balance
            wallet.balance = result.balance;
            saveWallet(wallet);
            this._showSuccess(bar, amountsDiv, successMsg, successText, walletHint,
              `$${amount} sent!`, allBtns, btn, amount);
            return;
          }

          if (result.error === 'insufficient_funds') {
            // Wallet empty — show hint, don't disrupt
            walletHint.classList.add('show');
            bar.classList.add('needs-funds');
            allBtns.forEach(b => b.disabled = false);
            btn.textContent = `$${amount}`;
            setTimeout(() => {
              bar.classList.remove('needs-funds');
              walletHint.classList.remove('show');
            }, 5000);
            return;
          }
        }

        // No wallet or wallet error — anonymous tip via Stripe
        const result = await apiPost('/tip/checkout', {
          author,
          authorName,
          subject: subject || undefined,
          subjectName: subjectName || undefined,
          amount,
          splitPct: subject ? splitPct : undefined,
          returnUrl: window.location.href,
        });

        if (result.checkoutUrl) {
          // For anonymous tips, we do need to go to Stripe — but in a popup, not navigation
          const popup = window.open(result.checkoutUrl, 'simpletip-pay',
            'width=450,height=600,scrollbars=yes');

          // Listen for completion
          const checkClosed = setInterval(() => {
            if (popup && popup.closed) {
              clearInterval(checkClosed);
              // Optimistically show success (Stripe webhook confirms later)
              this._showSuccess(bar, amountsDiv, successMsg, successText, walletHint,
                `$${amount} sent!`, allBtns, btn, amount);
            }
          }, 500);

          // Also listen for postMessage from our success page
          const msgHandler = (event) => {
            if (event.data && event.data.type === 'simpletip-payment-complete') {
              clearInterval(checkClosed);
              window.removeEventListener('message', msgHandler);
              if (popup && !popup.closed) popup.close();
              this._showSuccess(bar, amountsDiv, successMsg, successText, walletHint,
                `$${amount} sent!`, allBtns, btn, amount);
            }
          };
          window.addEventListener('message', msgHandler);
        } else {
          throw new Error(result.error || 'checkout failed');
        }
      } catch (err) {
        // Error — reset buttons
        allBtns.forEach(b => b.disabled = false);
        btn.textContent = `$${amount}`;
        console.error('SimpleTip error:', err);
      }
    }

    _showSuccess(bar, amountsDiv, successMsg, successText, walletHint, text, allBtns, btn, amount) {
      // Flash green — the key UX moment
      bar.classList.add('success');
      amountsDiv.classList.add('hide');
      walletHint.classList.remove('show');
      successText.textContent = text;
      successMsg.classList.add('show');

      // Emit event for host page
      this.dispatchEvent(new CustomEvent('tip', {
        bubbles: true,
        detail: { amount },
      }));

      // Reset after 2.5s
      setTimeout(() => {
        bar.classList.remove('success');
        amountsDiv.classList.remove('hide');
        successMsg.classList.remove('show');
        allBtns.forEach(b => b.disabled = false);
        btn.textContent = `$${amount}`;
      }, 2500);
    }

    _openFundingPopup(author) {
      const w = window.open(`${API.replace('/api', '')}/fund.html`, 'simpletip-fund',
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
              `<script src="${API.replace('/api', '')}/simpletip.js"><\/script>\n<simple-tip author="${resp.slug}" author-name="${esc(name)}"></simple-tip>`;
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
