/**
 * YouTube Ad Shield — Content Script (v6.0)
 * ==========================================
 * Four-layer defence:
 *   1. CSS hides banner/overlay/sidebar ads.
 *   2. Anti-adblock modal auto-dismissed.
 *   3. Video ads muted + sped to 16x the moment ad-showing class appears.
 *   4. Skip button clicked repeatedly until gone.
 */

(function () {
  'use strict';

  const STYLE_ID = 'yt-ad-shield-v6';

  // ─── CSS ────────────────────────────────────────────────────────────────
  const AD_CSS = `
    /* Feed / sidebar / banner ads */
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer,
    ytd-player-legacy-ad-renderer,
    ytd-ad-slot-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-action-companion-ad-renderer,
    ytd-display-ad-renderer,
    ytd-statement-banner-renderer,
    ytd-companion-card-renderer,
    ytd-banner-promo-renderer,
    ytd-carousel-ad-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    [layout="in-feed-ad-layout"],
    #masthead-ad,
    #player-ads,

    /* Overlay ads inside player */
    .ytp-ad-overlay-container,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay,
    .ytp-ad-overlay-close-container,

    /* Ad info / visit-advertiser strip */
    .ytp-ad-player-overlay-layout,
    .ytp-ad-player-overlay,
    .ytp-ad-simple-ad-badge,
    .ytp-ad-button-icon,
    .ytp-ad-visit-advertiser-button,
    .ytp-ad-clickable-overlay,
    .ytp-ad-action-interstitial,
    .ytp-ad-action-interstitial-slot,

    /* Progress-bar ad markers */
    .ytp-ad-progress,
    .ytp-ad-progress-list,

    /* Shopping / rich ads */
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    [data-ad-slot-id],
    [aria-label="Ads"] {
      display: none !important;
      height: 0 !important;
      min-height: 0 !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
  `;

  // ─── State ───────────────────────────────────────────────────────────────
  let enabled = true;
  let adObserver = null;
  let childObserver = null;
  let interval = null;
  let modalInterval = null;
  let wasAdActive = false;
  let lastTick = 0;
  let lastAdCount = 0;
  let userRate = 1.0;
  let userMuted = false;

  // ─── Styles ──────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = AD_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function removeStyles() { document.getElementById(STYLE_ID)?.remove(); }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function getPlayer() { return document.querySelector('#movie_player, .html5-video-player'); }
  function getVideo() {
    const p = getPlayer();
    return p ? p.querySelector('video') : null;
  }

  function isAdActive() {
    const p = getPlayer();
    if (!p) return false;
    if (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')) return true;
    // Backup: visible skip or countdown element
    for (const el of p.querySelectorAll(
      '.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.ytp-ad-duration-remaining'
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  // ─── Counter ─────────────────────────────────────────────────────────────
  function incrementCount() {
    const now = Date.now();
    if (now - lastAdCount < 1500) return;
    lastAdCount = now;
    chrome.storage.local.get({ adsSkipped: 0 }, d =>
      chrome.storage.local.set({ adsSkipped: d.adsSkipped + 1 })
    );
  }

  // ─── Track user prefs via events (not sampled from mid-ad video) ─────────
  function trackPrefs(video) {
    if (video.__prefTracked) return;
    video.__prefTracked = true;
    video.addEventListener('ratechange', () => { if (!isAdActive()) userRate = video.playbackRate; });
    video.addEventListener('volumechange', () => { if (!isAdActive()) userMuted = video.muted; });
  }

  // ─── Click every possible skip button ────────────────────────────────────
  function clickSkip() {
    const p = getPlayer();
    if (!p) return;
    const sels = [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-slot button',
    ];
    for (const sel of sels) {
      for (const btn of p.querySelectorAll(sel)) {
        try { btn.click(); } catch (_) {}
      }
    }
    // Language-agnostic skip via aria-label
    for (const btn of p.querySelectorAll('button[aria-label]')) {
      if ((btn.getAttribute('aria-label') || '').toLowerCase().includes('skip')) {
        try { btn.click(); } catch (_) {}
      }
    }
  }

  // ─── Anti-adblock modal dismissal ────────────────────────────────────────
  // YouTube shows "Ad blockers aren't allowed" which pauses playback.
  // We click the dismiss button and force-resume the video.
  function dismissAntiAdblock() {
    // Dismiss known modal containers
    const containers = document.querySelectorAll(
      'ytd-enforcement-message-view-model, yt-confirm-dialog-renderer'
    );
    for (const el of containers) {
      // Click #dismiss-button if present
      const dismiss = el.querySelector('#dismiss-button button, #dismiss-button');
      if (dismiss) { try { dismiss.click(); } catch (_) {} }

      // Click any button whose text looks like a confirmation
      for (const btn of el.querySelectorAll('button, tp-yt-paper-button')) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (
          text === 'ok' ||
          text === 'continue' ||
          text === 'i understand' ||
          text.includes('continue watching') ||
          text.includes('proceed') ||
          text.includes('got it')
        ) {
          try { btn.click(); } catch (_) {}
        }
      }
    }

    // If the video was paused by the modal and no ad is active, resume it
    const video = getVideo();
    if (video && video.paused && !isAdActive()) {
      try { video.play(); } catch (_) {}
    }

    // Also remove the backdrop overlay that greys out the page
    document.querySelectorAll(
      'tp-yt-iron-overlay-backdrop[opened], ytd-enforcement-message-view-model'
    ).forEach(el => {
      if (el.tagName.toLowerCase() === 'ytd-enforcement-message-view-model') {
        el.style.setProperty('display', 'none', 'important');
      } else {
        // Remove backdrop so video underneath is accessible
        el.removeAttribute('opened');
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }

  // ─── Handle an active ad ──────────────────────────────────────────────────
  function handleAd() {
    const video = getVideo();
    if (!video) return;

    trackPrefs(video);
    incrementCount();

    // Mute immediately
    video.muted = true;

    // Speed to 16x — ad ends in ~1 second
    try { if (video.playbackRate < 16) video.playbackRate = 16; } catch (_) {}

    // Seek to near end for skippable ads with known duration
    if (video.duration && isFinite(video.duration) && video.duration < 90) {
      if (video.duration - video.currentTime > 0.5) {
        try { video.currentTime = video.duration - 0.1; } catch (_) {}
      }
    }

    // Hammer skip button
    clickSkip();
    setTimeout(clickSkip, 100);
    setTimeout(clickSkip, 400);
    setTimeout(clickSkip, 900);
  }

  function restoreAfterAd() {
    setTimeout(() => {
      const v = getVideo();
      if (!v) return;
      try { v.playbackRate = userRate; } catch (_) {}
      v.muted = userMuted;
    }, 300);
  }

  // ─── Tick ─────────────────────────────────────────────────────────────────
  function tick() {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastTick < 150) return;
    lastTick = now;

    const adNow = isAdActive();
    if (adNow) { handleAd(); wasAdActive = true; }
    else if (wasAdActive) { restoreAfterAd(); wasAdActive = false; }
  }

  // ─── Observer setup ───────────────────────────────────────────────────────
  function startObserver() {
    if (adObserver) return;
    const p = getPlayer();
    if (p) {
      adObserver = new MutationObserver(tick);
      adObserver.observe(p, { attributes: true, attributeFilter: ['class'] });

      // Watch direct children only (skip button container appears here)
      childObserver = new MutationObserver(tick);
      childObserver.observe(p, { childList: true, subtree: false });
    }
    interval = setInterval(tick, 250);

    // Anti-adblock modal check — runs every 500ms independently
    modalInterval = setInterval(dismissAntiAdblock, 500);
  }

  function stopObserver() {
    adObserver?.disconnect(); adObserver = null;
    childObserver?.disconnect(); childObserver = null;
    if (interval) { clearInterval(interval); interval = null; }
    if (modalInterval) { clearInterval(modalInterval); modalInterval = null; }
  }

  function waitForPlayer() {
    if (getPlayer()) { startObserver(); return; }
    const obs = new MutationObserver(() => {
      if (getPlayer()) { obs.disconnect(); startObserver(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  function updateState() {
    if (enabled) { injectStyles(); waitForPlayer(); }
    else { removeStyles(); stopObserver(); restoreAfterAd(); }
  }

  // SPA navigation re-attach
  document.addEventListener('yt-navigate-finish', () => {
    if (!enabled) return;
    stopObserver();
    wasAdActive = false;
    waitForPlayer();
  });

  // Also catch the anti-adblock modal on page load
  document.addEventListener('yt-page-data-updated', dismissAntiAdblock);

  // ─── Init ─────────────────────────────────────────────────────────────────
  injectStyles();

  chrome.storage.local.get({ enabled: true }, d => {
    enabled = d.enabled;
    updateState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled !== undefined) {
      enabled = changes.enabled.newValue;
      updateState();
    }
  });

  console.log('[YT-AdShield] content v6.0 ready.');
})();
