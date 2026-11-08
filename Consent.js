/**
 * More Coffee — cookie consent + Google Analytics (GA4).
 *
 * Google Analytics only loads AFTER a visitor clicks "Accept". Reject (or no choice) = nothing
 * loads and no analytics cookies are set. The choice is remembered in this browser
 * (localStorage, which is strictly necessary to remember it) and can be changed any time
 * from the "Cookie settings" link in the footer (any element with data-cookie-settings).
 *
 * Used on every page: <script src="/consent.js" defer></script>
 */
(function () {
  'use strict';

  var GA_ID = 'G-RPPXSY28FD';
  var KEY = 'gmc-consent';            // 'granted' | 'denied'
  var VERSION = '1';                  // bump if the cookie notice changes and everyone should be asked again

  // ── Remembering the choice (wrapped: storage can be blocked) ──
  function getChoice() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && v.v === VERSION ? v.c : null;
    } catch (e) { return null; }
  }
  function setChoice(c) {
    try { localStorage.setItem(KEY, JSON.stringify({ c: c, v: VERSION, at: new Date().toISOString() })); } catch (e) { /* not stored */ }
  }

  // ── Google Analytics ──
  var gaLoaded = false;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function loadGA() {
    if (gaLoaded) return;
    gaLoaded = true;
    window['ga-disable-' + GA_ID] = false;
    gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    });
    gtag('js', new Date());
    gtag('config', GA_ID, {
      allow_google_signals: false,              // no cross-device / demographics
      allow_ad_personalization_signals: false,  // never used for ads
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  function stopGA() {
    window['ga-disable-' + GA_ID] = true;      // stops any further hits on this page
    if (gaLoaded) gtag('consent', 'update', { analytics_storage: 'denied' });
    // Remove GA cookies already set (_ga, _ga_XXXX) on this domain and its parent.
    var host = location.hostname, parts = host.split('.');
    var domains = ['', host, '.' + host];
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (!/^_ga(_|$)/.test(name)) return;
      domains.forEach(function (d) {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  // ── Events worth knowing: which deals people click and copy (only sent once GA has loaded) ──
  document.addEventListener('click', function (e) {
    if (!gaLoaded || !e.target.closest) return;
    var deal = e.target.closest('[data-ga-deal]');
    if (deal) {
      gtag('event', 'deal_click', {
        roaster: deal.getAttribute('data-ga-brand') || '',
        deal_id: deal.getAttribute('data-ga-deal') || '',
        method: deal.getAttribute('data-ga-method') || '',
        category: deal.getAttribute('data-ga-cat') || '',
        transport_type: 'beacon',
      });
      return;
    }
    var code = e.target.closest('.code__btn');
    if (code) gtag('event', 'copy_code', { roaster: code.getAttribute('data-ga-brand') || '', code: code.getAttribute('data-code') || '' });
  }, true);

  // ── The banner ──
  var css = '' +
    '.cc{position:fixed;left:16px;right:16px;bottom:16px;z-index:80;max-width:560px;margin:0 auto;background:var(--paper,#fff);color:var(--ink,#111);' +
    'box-shadow:0 -3px 0 0 var(--ink,#111),0 3px 0 0 var(--ink,#111),-3px 0 0 0 var(--ink,#111),3px 0 0 0 var(--ink,#111),9px 9px 0 0 var(--primary,#705EFF);' +
    'padding:18px 20px;font-family:var(--body,system-ui,sans-serif);font-size:15px;line-height:1.5;transform:translateY(160%);transition:transform .3s steps(5)}' +
    '.cc.on{transform:none}' +
    '.cc h2{font-family:var(--pixel,monospace);font-weight:400;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px}' +
    '.cc p{margin:0 0 14px}' +
    '.cc a{color:var(--primary-dk,#5442E6)}' +
    '.cc__btns{display:flex;gap:12px;flex-wrap:wrap}' +
    '.cc__btn{flex:1 1 140px;font-family:var(--pixel,monospace);font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding:12px 14px;border:0;cursor:pointer;' +
    'background:var(--paper,#fff);color:var(--ink,#111);box-shadow:0 -3px 0 0 var(--ink,#111),0 3px 0 0 var(--ink,#111),-3px 0 0 0 var(--ink,#111),3px 0 0 0 var(--ink,#111)}' +
    '.cc__btn:hover,.cc__btn:focus-visible{background:var(--primary,#705EFF);color:var(--paper,#fff);outline:none}' +
    '@media (max-width:640px){.cc{left:12px;right:12px;bottom:12px;padding:16px;font-size:14px}}' +
    '@media (prefers-reduced-motion:reduce){.cc{transition:none}}';

  var box = null;
  function showBanner() {
    if (!box) {
      var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      box = document.createElement('section');
      box.className = 'cc';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Cookie choice');
      box.innerHTML =
        '<h2>Cookies?</h2>' +
        '<p>We\'d like to use Google Analytics to see which pages and deals are useful, so we can make More Coffee better. ' +
        'It\'s only switched on if you say yes. No ads, no selling data. <a href="/privacy#cookies">Privacy policy</a></p>' +
        '<div class="cc__btns">' +
        '<button type="button" class="cc__btn" data-cc="denied">Reject</button>' +
        '<button type="button" class="cc__btn" data-cc="granted">Accept</button>' +
        '</div>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-cc]');
        if (!b) return;
        var c = b.getAttribute('data-cc');
        setChoice(c);
        if (c === 'granted') loadGA(); else stopGA();
        hideBanner();
      });
      document.body.appendChild(box);
    }
    box.hidden = false;
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add('on'); }); });
  }
  function hideBanner() {
    if (!box) return;
    box.classList.remove('on');
    setTimeout(function () { if (box && !box.classList.contains('on')) box.hidden = true; }, 350);
  }

  // Footer "Cookie settings" links
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cookie-settings]');
    if (!t) return;
    e.preventDefault();
    showBanner();
  });

  function start() {
    var c = getChoice();
    if (c === 'granted') loadGA();
    else if (c === 'denied') stopGA();
    else showBanner();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
