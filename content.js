/**
 * YouTube Ad Shield — Content Script (v5.0)
 * ==========================================
 * Aggressive multi-layer ad elimination:
 *   1. CSS hides feed/banner/overlay ads instantly.
 *   2. Speed-forces ads to 16x (they end in ~1 sec).
 *   3. Seeks to end of skippable ads immediately.
 *   4. Clicks skip buttons.
 *   5. MutationObserver + interval for zero-latency detection.
 */

(function () {
  'use strict';

  const STYLE_ID = 'yt-ad-shield-styles';

  // ─── Comprehensive CSS — covers 2024/2025 YouTube ad elements ────────
  const AD_CSS = `
    /* In-feed / sidebar ads */
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
    ytd-ad-slot-renderer[class*="ad"],
    [layout="in-feed-ad-layout"],
    #rendering-content ytd-in-feed-ad-layout-renderer,
    #masthead-ad,
    #player-ads,
    .ytd-display-ad-renderer,

    /* Overlay ads inside the player */
    .ytp-ad-overlay-container,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay,
    .ytp-ad-overlay-close-container,
    .ytp-ad-overlay-ad-info-button-container,

    /* Survey / companion cards */
    .ytp-ad-action-interstitial,
    .ytp-ad-action-interstitial-background,
    .ytp-ad-action-interstitial-slot,

    /* Info bar ("Ad · X:XX left") — hidden via CSS so user doesn't see it */
    .ytp-ad-player-overlay-layout,
    .ytp-ad-player-overlay,
    .ytp-ad-simple-ad-badge,
    .ytp-ad-button-icon,
    .ytp-ad-visit-advertiser-button,
    .ytp-ad-clickable-overlay,

    /* Shopping ads */
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),

    /* Any generic "ad" containers YouTube uses */
    [class*="__ad-badge"],
    [aria-label="Ads"],
    [data-ad-slot-id] {
      display: none !important;
      height: 0 !important;
      min-height: 0 !important;
      width: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }

    /* Keep video visible during ad (we speed it up instead of hiding) */
    .ad-showing video,
    .ad-interrupting video {
      opacity: 1 !important;
    }

    /* Hide progress bar ad markers */
    .ytp-ad-progress,
    .ytp-ad-progress-list {
      display: none !important;
    }
  `;

  let extensionEnabled = true;
  let adObserver = null;
  let childObserver = null;
  let checkInterval = null;
  let userPlaybackRate = 1.0;
  let userMuted = false;
  let wasAdActive = false;
  let lastAdCountTime = 0;
  let lastTickTime = 0;
  let adSkipAttempts = 0;

  // ─── Counter ─────────────────────────────────────────────────────────
  function incrementAdCount() {
    const now = Date.now();
    if (now - lastAdCountTime < 1500) return;
    lastAdCountTime = now;
    chrome.storage.local.get({ adsSkipped: 0 }, (data) => {
      chrome.storage.local.set({ adsSkipped: data.adsSkipped + 1 });
    });
  }

  // ─── Styles ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = AD_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ─── Player / Video helpers ───────────────────────────────────────────
  function getPlayer() {
    return document.querySelector('#movie_player');
  }

  function getVideo() {
    const p = getPlayer();
    return p ? p.querySelector('video') : null;
  }

  // ─── Ad detection ─────────────────────────────────────────────────────
  function isAdActive() {
    const player = getPlayer();
    if (!player) return false;

    // Primary signal: YouTube's own class
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      return true;
    }

    // Secondary: visible skip or countdown elements inside the player
    const adIndicators = player.querySelectorAll(
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, ' +
      '.ytp-ad-duration-remaining, .ytp-ad-simple-ad-badge'
    );
    for (const el of adIndicators) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }

    return false;
  }

  // ─── Click all skip buttons ──────────────────────────────────────────
  function clickSkip() {
    const player = getPlayer();
    if (!player) return false;

    const selectors = [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-slot button',
      'button[class*="skip"]',
      '[id*="skip-button"]',
    ];

    let clicked = false;
    for (const sel of selectors) {
      for (const btn of player.querySelectorAll(sel)) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          try { btn.click(); clicked = true; } catch (e) {}
        }
      }
    }

    // Language-agnostic: any visible button with "skip" in aria-label
    for (const btn of player.querySelectorAll('button[aria-label]')) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('skip')) {
        try { btn.click(); clicked = true; } catch (e) {}
      }
    }

    return clicked;
  }

  // ─── Track user preferences via events (not sampled from mid-ad video) ──
  // inject.js's play() override may have already set playbackRate=16 and
  // muted=true before our first MutationObserver tick fires. Capturing
  // video.playbackRate inside handleAd() would save 16 as the "user" rate.
  // Instead, we listen to ratechange/volumechange during CONTENT playback.
  function trackUserPreferences(video) {
    if (video.__prefTracked) return;
    video.__prefTracked = true;
    video.addEventListener('ratechange', () => {
      if (!isAdActive()) userPlaybackRate = video.playbackRate;
    });
    video.addEventListener('volumechange', () => {
      if (!isAdActive()) userMuted = video.muted;
    });
  }

  // ─── Core ad handler ─────────────────────────────────────────────────
  function handleAd() {
    const video = getVideo();
    if (!video) return;

    trackUserPreferences(video);
    incrementAdCount();

    if (!video.__adHandled) {
      video.__adHandled = true;
      adSkipAttempts = 0;
    }

    // Always mute the ad
    video.muted = true;

    // Strategy 1: Jump to end of skippable ads (short duration = ad)
    if (video.duration && isFinite(video.duration) && video.duration > 0 && video.duration < 90) {
      const remaining = video.duration - video.currentTime;
      if (remaining > 0.5) {
        try {
          video.currentTime = video.duration - 0.1;
        } catch (e) {}
      }
    }

    // Strategy 2: Speed up to 16x so non-skippable ads end in ~1 second
    try {
      if (video.playbackRate < 16) {
        video.playbackRate = 16;
      }
    } catch (e) {}

    // Strategy 3: Click skip button (works after time-jump triggers skipability)
    clickSkip();
    adSkipAttempts++;

    // Strategy 4: Hammer skip button for a short window after detection
    if (adSkipAttempts < 5) {
      setTimeout(clickSkip, 100);
      setTimeout(clickSkip, 300);
      setTimeout(clickSkip, 600);
    }
  }

  function restoreAfterAd() {
    const video = getVideo();
    if (video && video.__adHandled) {
      // Small delay to avoid restoring during the ad→content transition
      setTimeout(() => {
        const v = getVideo();
        if (v) {
          try { v.playbackRate = userPlaybackRate; } catch (e) {}
          v.muted = userMuted;
        }
        delete video.__adHandled;
      }, 200);
    }
  }

  // ─── Tick ─────────────────────────────────────────────────────────────
  function tick() {
    if (!extensionEnabled) return;

    const now = Date.now();
    if (now - lastTickTime < 150) return;
    lastTickTime = now;

    const adNow = isAdActive();
    if (adNow) {
      handleAd();
      wasAdActive = true;
    } else if (wasAdActive) {
      restoreAfterAd();
      wasAdActive = false;
    }
  }

  // ─── Observer setup ───────────────────────────────────────────────────
  function startObserver() {
    if (adObserver) return;

    const player = getPlayer();
    if (player) {
      // Watch class changes on the player (ad-showing toggled here)
      adObserver = new MutationObserver(tick);
      adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });

      // Watch direct children only (skip button container added at this level)
      // Deliberately NOT subtree:true to avoid firing on every caption/progress update
      childObserver = new MutationObserver(tick);
      childObserver.observe(player, { childList: true, subtree: false });
    }

    // Fallback interval — catches anything observer misses
    checkInterval = setInterval(tick, 250);
  }

  function stopObserver() {
    adObserver?.disconnect();
    adObserver = null;
    childObserver?.disconnect();
    childObserver = null;
    if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
  }

  function waitForPlayer() {
    if (getPlayer()) {
      startObserver();
      return;
    }
    const obs = new MutationObserver(() => {
      if (getPlayer()) { obs.disconnect(); startObserver(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  function updateState() {
    if (extensionEnabled) {
      injectStyles();
      waitForPlayer();
    } else {
      removeStyles();
      stopObserver();
      restoreAfterAd();
    }
  }

  // ─── Handle YouTube's SPA navigation ─────────────────────────────────
  // YouTube navigates without full page reload; re-attach after navigation.
  document.addEventListener('yt-navigate-finish', () => {
    if (!extensionEnabled) return;
    stopObserver();
    adObserver = null;
    wasAdActive = false;
    waitForPlayer();
  });

  // ─── Init ─────────────────────────────────────────────────────────────
  injectStyles(); // inject CSS as early as possible

  chrome.storage.local.get({ enabled: true }, (data) => {
    extensionEnabled = data.enabled;
    updateState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled !== undefined) {
      extensionEnabled = changes.enabled.newValue;
      updateState();
    }
  });

  // Signal from inject.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'YT_AD_SHIELD_BLOCKED') return;
    if (!extensionEnabled) return;
    incrementAdCount();
  });

  console.log('[YT-AdShield] Content script v5.0 initialized.');
})();
