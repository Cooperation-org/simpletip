/**
 * SimpleTip — embeddable tipping web component
 *
 * Usage:
 *   <simple-tip receiver="slug" receiver-name="Name"></simple-tip>
 *
 * Split tips:
 *   <simple-tip receiver="author-slug" receiver-name="Author"
 *     subject="subject-slug" subject-label="Subject Name"></simple-tip>
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
  const GREEN_DARK = '#16a34a';
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

  // ── API helpers ───────────────────────────────────────────

  async function apiPost(path, body) {
    const wallet = getWallet();
    const headers = { 'Content-Type': 'application/json' };
    if (wallet && wallet.token) headers['Authorization'] = `Bearer ${wallet.token}`;
    const resp = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return resp.json();
  }

  // ── Widget load (register article + get receiver info) ────

  async function widgetLoad(pageUrl, pageTitle, receiverSlugs) {
    try {
      return await apiPost('/widget/load', {
        page_url: pageUrl,
        page_title: pageTitle || document.title,
        site_name: document.location.hostname,
        receivers: receiverSlugs,
      });
    } catch (e) {
      console.error('SimpleTip: widget load failed', e);
      return null;
    }
  }

  // ── <simple-tip> ──────────────────────────────────────────

  class SimpleTip extends HTMLElement {
    async connectedCallback() {
      // Support both old (author/subject) and new (receiver/subject) attributes
      const receiver = this.getAttribute('receiver') || this.getAttribute('author') || '';
      const receiverName = this.getAttribute('receiver-name') || this.getAttribute('author-name') || receiver;
      const receiverImg = this.getAttribute('receiver-img') || this.getAttribute('author-img') || '';
      const subject = this.getAttribute('subject') || '';
      const subjectName = this.getAttribute('subject-label') || subject;
      const defaultAmounts = (this.getAttribute('amounts') || '1,3,5').split(',').map(Number);
      const demoAnonymous = this.hasAttribute('demo-anonymous');
      const isSplit = !!subject;

      // Build receiver list for API calls
      const receiverSlugs = [receiver];
      if (subject) receiverSlugs.push(subject);

      // Register article + record impression
      const loadResult = await widgetLoad(window.location.href, document.title, receiverSlugs);
      if (!loadResult || loadResult.detail || loadResult.error) {
        // Receiver not found or no payout method — don't render
        console.warn('SimpleTip: not rendering —', loadResult?.detail || loadResult?.error || 'load failed');
        return;
      }

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
          .amt.pledge-mode { background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); }
          .amt.pledge-mode:hover { background: rgba(255,255,255,0.3); }
          .amt.topup-mode { background: ${GOLD}; color: #fff; }
          .amt.topup-mode:hover { background: #d97706; }

          .success-msg { display: none; font-size: 0.82rem; font-weight: 600; align-items: center; gap: 6px; }
          .success-msg.show { display: flex; }
          .amounts.hide { display: none; }
          .support-link { cursor: pointer; opacity: 0.85; text-decoration: underline; text-decoration-style: dotted; }
          .support-link:hover { opacity: 1; }
          .tip-again { background: rgba(255,255,255,0.2); color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 6px; padding: 4px 10px; font-size: 0.72rem; cursor: pointer; margin-left: 6px; }
          .tip-again:hover { background: rgba(255,255,255,0.3); }

          .split-row {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 16px 8px; background: rgba(63,37,52,0.06);
            border-radius: 0 0 10px 10px; font-size: 0.75rem; color: #555;
          }
          .split-row input[type=range] { flex: 1; accent-color: ${ACCENT}; height: 4px; }
          .split-pct { font-weight: 600; min-width: 28px; text-align: center; font-size: 0.72rem; }
          .split-label { font-size: 0.68rem; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

          .comment-row {
            display: none; padding: 8px 16px; background: rgba(63,37,52,0.03);
          }
          .comment-row.show { display: block; }
          .comment-row input {
            width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px;
            font-size: 0.78rem; background: #fff;
          }

          .footer { display: flex; align-items: center; gap: 6px; font-size: 0.6rem; opacity: 0.35; padding: 3px 16px 0; justify-content: flex-end; }
          .footer a { color: inherit; text-decoration: none; }

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
            border-radius: 4px; white-space: nowrap; flex-shrink: 0; cursor: pointer;
          }
          .bal-badge.show { display: block; }
          .bal-badge:hover { background: rgba(255,255,255,0.25); }
        </style>

        <div class="tip-bar" id="bar">
          ${receiverImg ? `<img class="avatar" src="${esc(receiverImg)}" alt="${esc(receiverName)}">` : ''}
          <div class="info">
            <div class="who" id="whoLabel">Tip ${esc(receiverName)}${isSplit ? ' + ' + esc(subjectName) : ''}</div>
            <div class="sub" id="subLabel">powered by SimpleTip</div>
          </div>
          <div class="bal-badge" id="balBadge" title="Your wallet balance"></div>
          <div class="amounts" id="amounts">
            ${defaultAmounts.map(a => `<button class="amt" data-amount="${a}">$${a}</button>`).join('')}
          </div>
          <div class="success-msg" id="successMsg">
            <span>&#10003;</span>
            <span id="successText">Thank you!</span>
            <span class="support-link" id="supportLink">Your support matters.</span>
            <button class="tip-again" id="tipAgainBtn" style="display:none;">Tip again</button>
          </div>
        </div>
        ${isSplit ? `
        <div class="split-row" id="splitRow">
          <span class="split-label">${esc(receiverName)}</span>
          <span class="split-pct" id="receiverPct">50%</span>
          <input type="range" id="slider" min="10" max="90" value="50" step="10">
          <span class="split-pct" id="subjectPct">50%</span>
          <span class="split-label">${esc(subjectName)}</span>
        </div>` : ''}
        <div class="comment-row" id="commentRow">
          <input type="text" id="commentInput" placeholder="Add a message (optional)" maxlength="280">
        </div>
        <div class="wallet-hint" id="walletHint">
          <span id="hintText"><a id="addFundsLink">Add funds</a> to your wallet to tip with one click.</span>
        </div>
        <div class="footer">
          <a href="${BASE_URL}/wallet.html" target="_blank">SimpleTip</a>
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
      const receiverPctEl = shadow.getElementById('receiverPct');
      const subjectPctEl = shadow.getElementById('subjectPct');
      const addFundsLink = shadow.getElementById('addFundsLink');
      const balBadge = shadow.getElementById('balBadge');
      const commentRow = shadow.getElementById('commentRow');
      const commentInput = shadow.getElementById('commentInput');
      const tipAgainBtn = shadow.getElementById('tipAgainBtn');
      const supportLink = shadow.getElementById('supportLink');
      const allBtns = shadow.querySelectorAll('.amt');
      let hasTipped = false;
      let totalTippedCents = 0; // all-time total from DB

      const _getWallet = () => demoAnonymous ? null : getWallet();

      const _updateState = () => {
        // After tipping, stay in thank-you state
        if (hasTipped) {
          bar.classList.add('success');
          bar.classList.remove('needs-funds');
          amountsDiv.classList.add('hide');
          successMsg.classList.add('show');
          successText.textContent = 'Thank you!';
          supportLink.textContent = 'Your support matters.';
          supportLink.style.display = '';
          tipAgainBtn.style.display = '';
          commentRow.classList.remove('show');
          // Still update balance badge
          const w = _getWallet();
          if (w && w.token) {
            const bal = (typeof w.balance === 'number' ? w.balance : 0) / 100;
            balBadge.textContent = `$${bal.toFixed(2)}`;
            balBadge.classList.add('show');
          }
          return;
        }
        const w = _getWallet();
        const balCents = (w && typeof w.balance === 'number') ? w.balance : 0;
        const isLoggedIn = w && w.token;
        const minAmountCents = Math.min(...defaultAmounts) * 100;
        const canTipAny = isLoggedIn && balCents >= minAmountCents;

        if (isLoggedIn) {
          const bal = balCents / 100;
          balBadge.textContent = `$${bal.toFixed(2)}`;
          balBadge.classList.add('show');
        } else {
          balBadge.classList.remove('show');
        }

        if (canTipAny) {
          whoLabel.textContent = `Tip ${receiverName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = 'powered by SimpleTip';
          // Per-button: if balance covers it → normal tip, otherwise → top up
          allBtns.forEach(b => {
            const amt = parseFloat(b.dataset.amount) * 100;
            b.classList.remove('pledge-mode', 'topup-mode');
            if (amt > balCents) {
              b.classList.add('topup-mode');
              b.title = 'Top up to tip this amount';
            } else {
              b.title = '';
            }
          });
          commentRow.classList.add('show');
        } else if (isLoggedIn && balCents > 0) {
          // Has some balance but not enough for even the smallest tip
          whoLabel.textContent = `Tip ${receiverName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = 'top up your wallet to tip';
          bar.classList.add('needs-funds');
          allBtns.forEach(b => { b.classList.remove('pledge-mode'); b.classList.add('topup-mode'); b.title = 'Top up to tip'; });
          commentRow.classList.add('show');
        } else {
          // No funds or no wallet — show tip label, clicking opens fund popup
          whoLabel.textContent = `Tip ${receiverName}${isSplit ? ' + ' + subjectName : ''}`;
          subLabel.textContent = isLoggedIn ? 'add funds to tip' : 'powered by SimpleTip';
          bar.classList.remove('needs-funds');
          allBtns.forEach(b => { b.classList.remove('pledge-mode', 'topup-mode'); b.title = ''; });
          commentRow.classList.remove('show');
        }
      };
      _updateState();

      balBadge.addEventListener('click', () => this._openFundingPopup());

      tipAgainBtn.addEventListener('click', () => {
        hasTipped = false;
        bar.classList.remove('success');
        amountsDiv.classList.remove('hide');
        successMsg.classList.remove('show');
        tipAgainBtn.style.display = 'none';
        supportLink.style.display = '';
        allBtns.forEach(b => b.disabled = false);
        _updateState();
      });

      supportLink.addEventListener('click', async () => {
        // Fetch all-time total from DB
        const w = getWallet();
        if (w && w.token) {
          try {
            const headers = { 'Authorization': `Bearer ${w.token}` };
            const resp = await fetch(`${API}/wallet`, { headers });
            const data = await resp.json();
            if (data.totalTipped != null) {
              totalTippedCents = data.totalTipped;
            }
          } catch (e) {}
        }
        const totalStr = (totalTippedCents / 100).toFixed(2);
        supportLink.textContent = `You've given $${totalStr} total`;
      });

      window.addEventListener('message', (event) => {
        if (event.data && (event.data.type === 'simpletip-wallet-updated' || event.data.type === 'simpletip-auth')) {
          saveWallet(event.data.wallet);
          _updateState();
        }
      });

      if (slider) {
        slider.addEventListener('input', () => {
          const v = parseInt(slider.value);
          receiverPctEl.textContent = v + '%';
          subjectPctEl.textContent = (100 - v) + '%';
        });
      }

      if (addFundsLink) {
        addFundsLink.addEventListener('click', (e) => { e.preventDefault(); this._openFundingPopup(); });
      }

      // Build receivers array for API
      const buildReceivers = () => {
        const splitPct = slider ? parseInt(slider.value) : 100;
        const receivers = [{ slug: receiver, pct: splitPct, role: 'author' }];
        if (subject) {
          receivers.push({ slug: subject, pct: 100 - splitPct, role: 'subject' });
        }
        return receivers;
      };

      allBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const amount = parseFloat(btn.dataset.amount);
          const wallet = _getWallet();
          const amountCents = Math.round(amount * 100);
          const comment = commentInput ? commentInput.value.trim() : '';
          const receivers = buildReceivers();

          const setTipped = (totalFromDb) => { hasTipped = true; if (totalFromDb != null) totalTippedCents = totalFromDb; };
          const ctx = { receivers, amount, comment, bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns, btn, _updateState, setTipped };

          if (wallet && wallet.token && wallet.balance >= amountCents) {
            this._handleTip(ctx);
          } else {
            // No wallet, no funds, or not enough — auto-create wallet if needed, then open fund popup
            this._handleAutoFund(ctx, amountCents);
          }
        });
      });
    }

    async _handleTip(ctx) {
      const { receivers, amount, comment, allBtns, btn, _updateState, setTipped } = ctx;
      allBtns.forEach(b => b.disabled = true);
      btn.textContent = '...';

      try {
        const result = await apiPost('/tip', {
          receivers,
          amount,
          comment: comment || undefined,
          page_url: window.location.href,
        });

        if (result.success) {
          const wallet = getWallet();
          if (wallet) { wallet.balance = result.balance; saveWallet(wallet); }
          setTipped(result.totalTipped);
          _updateState();
          this.dispatchEvent(new CustomEvent('tip', { bubbles: true, detail: { amount } }));
          return;
        }

        if (result.detail && result.detail.includes('insufficient_funds')) {
          this._handlePledge(ctx);
          return;
        }
      } catch (err) {
        console.error('SimpleTip error:', err);
      }
      allBtns.forEach(b => b.disabled = false);
      btn.textContent = `$${amount}`;
    }

    async _handlePledge(ctx) {
      const { receivers, amount, comment, bar, amountsDiv, successMsg, successText, walletHint, hintText, allBtns, btn, _updateState } = ctx;
      allBtns.forEach(b => b.disabled = true);
      btn.textContent = '...';

      try {
        const result = await apiPost('/pledge', {
          receivers,
          amount,
          comment: comment || undefined,
          page_url: window.location.href,
        });

        if (result.success) {
          const totalDollars = (result.pendingTotal / 100).toFixed(2);
          const msg = result.pendingTotal > Math.round(amount * 100)
            ? `Pledged $${amount}! ($${totalDollars} total)`
            : `Pledged $${amount}!`;
          this._showFlash(bar, amountsDiv, successMsg, successText, msg, 'pledged', allBtns, btn, amount, _updateState);

          if (result.pendingTotal >= 500) {
            setTimeout(() => {
              hintText.innerHTML = `You've pledged $${totalDollars}. <a id="fundNowLink">Fund your wallet</a> to send it!`;
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

    async _handleAutoFund(ctx, amountCents) {
      const { allBtns, btn, amount, _updateState } = ctx;

      // Auto-create wallet if none exists (cookie-style, no signup needed)
      let wallet = getWallet();
      if (!wallet || !wallet.token) {
        btn.textContent = '...';
        try {
          const result = await apiPost('/wallet/create', {});
          if (result.token) {
            wallet = { token: result.token, balance: result.balance || 0, name: result.name || '', email: result.email || null };
            saveWallet(wallet);
          }
        } catch (e) {
          console.error('SimpleTip: wallet create failed', e);
          btn.textContent = `$${amount}`;
          return;
        }
      }

      // Open funding popup — when it returns with funds, auto-tip
      const popup = window.open(`${BASE_URL}/fund.html`, 'simpletip-fund', 'width=420,height=550,scrollbars=yes');

      const msgHandler = (event) => {
        if (event.data && event.data.type === 'simpletip-wallet-updated') {
          window.removeEventListener('message', msgHandler);
          saveWallet(event.data.wallet);
          _updateState();
          if (popup && !popup.closed) popup.close();
          // If they now have enough, auto-send the tip
          const w = getWallet();
          if (w && w.balance >= amountCents) {
            this._handleTip(ctx);
          }
        }
      };
      window.addEventListener('message', msgHandler);
    }

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
      const w = window.open(`${BASE_URL}/fund.html`, 'simpletip-fund', 'width=420,height=550,scrollbars=yes');

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

  customElements.define('simple-tip', SimpleTip);
})();
