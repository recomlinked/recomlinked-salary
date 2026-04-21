(function() {
  'use strict';

  // ── 1. Favicon ────────────────────────────────────────
  if (!document.querySelector('link[rel="icon"]')) {
    var l = document.createElement('link');
    l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = '/favicon.svg';
    document.head.appendChild(l);
  }

  // ── 2. Google Analytics 4 ────────────────────────────
  (function() {
    if (document.querySelector('script[src*="googletagmanager"]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=G-C5GQLC5FHP';
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', 'G-C5GQLC5FHP');
  })();

  // ── 3. Microsoft Clarity (add your ID and uncomment) ──
  /*
  (function() {
    if (document.querySelector('script[src*="clarity.ms"]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.clarity.ms/tag/YOUR_CLARITY_ID';
    document.head.appendChild(s);
    window.clarity = window.clarity || function() { (window.clarity.q = window.clarity.q || []).push(arguments); };
  })();
  */

  // ── 4. Remove any existing footer (idempotency) ──────
  var old = document.querySelector('footer.recomlinked-footer');
  if (old) old.remove();

  // ── 5. Footer ────────────────────────────────────────
  var year = new Date().getFullYear();
  var footer = document.createElement('div');
  footer.innerHTML = ''
    + '<div style="height:3px;background:linear-gradient(90deg,#c9a84c,#00c4a0,#4488ff);"></div>'
    + '<footer class="recomlinked-footer" style="background:#07090f;padding:20px 32px;border-top:1px solid rgba(255,255,255,0.07);font-family:-apple-system,\'Segoe UI\',sans-serif;">'
    +   '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tr>'
    +     '<td style="vertical-align:middle;">'
    +       '<div style="font-size:14px;font-weight:700;color:#c9a84c;margin-bottom:5px;">Recomlinked \u00b7 Salary Negotiation Coach</div>'
    +       '<a href="https://www.linkedin.com/company/recomlinked/" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#454d60;text-decoration:none;">'
    +         '<svg width="13" height="13" viewBox="0 0 24 24" fill="#454d60"><path d="M20.447 20.452H17.21V14.88c0-1.328-.024-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.67H9.985V9h3.102v1.561h.043c.432-.818 1.487-1.681 3.062-1.681 3.275 0 3.879 2.156 3.879 4.961v6.611zM5.337 7.433a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zM6.959 20.452H3.712V9h3.247v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.226.792 24 1.771 24h20.451C23.2 24 24 23.226 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/></svg>'
    +         'Follow us'
    +       '</a>'
    +     '</td>'
    +     '<td style="text-align:right;vertical-align:middle;">'
    +       '<a href="https://risk.recomlinked.com/about/"          target="_blank" rel="noopener" style="font-size:13px;color:#8a90a8;text-decoration:none;margin-left:24px;">About</a>'
    +       '<a href="https://risk.recomlinked.com/contact/"        target="_blank" rel="noopener" style="font-size:13px;color:#8a90a8;text-decoration:none;margin-left:24px;">Contact</a>'
    +       '<a href="https://risk.recomlinked.com/privacy-policy/" target="_blank" rel="noopener" style="font-size:13px;color:#8a90a8;text-decoration:none;margin-left:24px;">Privacy</a>'
    +     '</td>'
    +   '</tr></table>'
    +   '<div style="text-align:center;width:100%;font-size:12px;color:#2e3347;padding-top:10px;border-top:1px solid rgba(255,255,255,0.04);">'
    +     '\u00a9 ' + year + ' Recomlinked Technologies Inc. All rights reserved.'
    +   '</div>'
    + '</footer>';
  document.body.appendChild(footer);

})();
