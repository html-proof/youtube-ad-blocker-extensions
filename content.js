/**
 * YouTube Ad Shield — Content Script (v4.1)
 * ==========================================
 * Runs in ISOLATED world (has chrome.storage access).
 * Two-layer defense:
 *   Layer 1: CSS hides feed/banner/overlay ads instantly.
 *   Layer 2: MutationObserver + interval detects video ads and
 *            fast-forwards + clicks skip as a fallback if inject.js
 *            didn't fully strip the ad from the API response.
 */

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────
  const STYLE_ID = 'yt-ad-shield-styles';
  const AD_HIDE_ID = 'yt-ad-hide-styles';

  // CSS to hide feed/banner/overlay ads across the page
  const AD_CSS = `
    ytd-promoted-sparkles-web-renderer,
    ytd-player-legacy-ad-renderer,
    .ytp-ad-overlay-container,
    .ytp-ad-image-overlay,
    #rendering-content .ytd-in-feed-ad-layout-renderer,
    ytd-ad-slot-renderer,
    .ytd-carousel-ad-renderer-renderer,
    .ytd-statement-banner-renderer,
    .ytd-companion-card-renderer,
    [layout="in-feed-ad-layout"],
    #player-ads,
    #masthead-ad,
    ytd-banner-promo-renderer {
      display: none !important;
      height: 0 !important;
      width: 0 !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;

  // CSS to hide ad overlays when an ad is active (don't touch the video element itself)
  const AD_HIDE_CSS = `
    .ad-showing .ytp-ad-player-overlay-layout,
    .ad-showing .ytp-ad-action-interstitial,
    .ad-showing .ytp-ad-overlay-container,
    .ad-interrupting .ytp-ad-player-overlay-layout,
    .ad-interrupting .ytp-ad-action-interstitial,
    .ad-interrupting .ytp-ad-overlay-container {
      display: none !important;
    }
  `;

  // ─── State ─────────────────────────────────────────────────────────
  let extensionEnabled = true;
  let adObserver = null;
  let checkInterval = null;
  let userPlaybackRate = 1.0;
  let userMuteState = false;
  let lastAdCountTime = 0;
  let adVideoElement = null; // track which video element is the ad

  // ─── Counter ───────────────────────────────────────────────────────
  function incrementAdCount() {
    const now = Date.now();
    if (now - lastAdCountTime < 2000) return;
    lastAdCountTime = now;
    chrome.storage.local.get({ adsSkipped: 0 }, (data) => {
      chrome.storage.local.set({ adsSkipped: data.adsSkipped + 1 });
    });
  }

  // ─── Style Management ─────────────────────────────────────────────
  function injectStyles() {
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = AD_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    if (!document.getElementById(AD_HIDE_ID)) {
      const s = document.createElement('style');
      s.id = AD_HIDE_ID;
      s.textContent = AD_HIDE_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(AD_HIDE_ID)?.remove();
  }

  // ─── Ad Detection (strictly inside #movie_player) ─────────────────
  function getPlayer() {
    return document.querySelector('#movie_player');
  }

  function isAdActive() {
    const player = getPlayer();
    if (!player) return false;

    // Primary: YouTube's native class — this is the ONLY reliable indicator
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      return true;
    }

    // Conservative fallback: only check for actual skip buttons being visible,
    // NOT generic ad text elements which persist in DOM after ads end.
    const skipButtons = player.querySelectorAll(
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button'
    );
    for (const el of skipButtons) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }

    return false;
  }

  // ─── Video Selection ──────────────────────────────────────────────
  function getVideo() {
    const player = getPlayer();
    if (!player) return null; // never operate on video outside the player
    return player.querySelector('video') || null;
  }

  // ─── Check if this video is actually an ad video ──────────────────
  // YouTube reuses the same <video> element for ads and content.
  // We can't reliably distinguish them by duration alone during transitions.
  // Instead, we rely purely on the player's class state.

  // ─── Skip Button Clicker ──────────────────────────────────────────
  function clickSkipButtons() {
    const player = getPlayer();
    if (!player) return;

    // All known skip button selectors strictly inside the player
    const btns = player.querySelectorAll([
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-slot',
      'button[class*="skip-button"]',
      'button[class*="skip-ad"]',
      '[id*="skip-button"]',
      'button[data-tooltip-target-id="a]"',
    ].join(', '));

    for (const btn of btns) {
      try { btn.click(); } catch (e) {}
      try {
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
          btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      } catch (e) {}
    }

    // Also try aria-label based skip (catches any language)
    const ariaSkips = player.querySelectorAll('button[aria-label]');
    for (const btn of ariaSkips) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('skip') && !label.includes('navigation')) {
        try { btn.click(); } catch (e) {}
      }
    }
  }

  // ─── Core Ad Handler ──────────────────────────────────────────────
  function handleAd() {
    const video = getVideo();
    if (!video) return;

    incrementAdCount();

    // Track which video element is the ad
    adVideoElement = video;

    // Save user state before we override
    if (!video.__adMuted) {
      userPlaybackRate = video.playbackRate || 1.0;
      userMuteState = video.muted;
    }
    video.__adMuted = true;

    // Mute the ad — this is always safe
    video.muted = true;

    // DO NOT set video.currentTime — YouTube shares the same <video>
    // element between ads and content, so skipping to near-end can
    // cause the real video to jump 15-20 seconds ahead.
    // DO NOT set playbackRate to 16 — same risk of bleeding into content.

    // Click skip buttons — this is the primary and safest skip mechanism
    clickSkipButtons();
  }

  function restoreAfterAd() {
    // Restore on the tracked ad video element OR the current video
    const video = adVideoElement || getVideo();
    if (video) {
      if (video.__adMuted) {
        video.muted = userMuteState;
        delete video.__adMuted;
      }
      try { video.playbackRate = userPlaybackRate; } catch (e) {}
    }
    adVideoElement = null;

    // Also ensure the current video (which may be different after ad) is clean
    const currentVideo = getVideo();
    if (currentVideo && currentVideo !== video) {
      try { currentVideo.playbackRate = userPlaybackRate; } catch (e) {}
      currentVideo.muted = userMuteState;
    }
  }

  // ─── Observer + Interval ──────────────────────────────────────────
  let wasAdActive = false;
  let lastTickTime = 0;

  function tick() {
    if (!extensionEnabled) return;

    // Throttle: max once per 200ms to prevent CPU overload
    const now = Date.now();
    if (now - lastTickTime < 200) return;
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

  function startObserver() {
    if (adObserver) return;

    const player = getPlayer();
    if (player) {
      // ONLY watch class changes on the player itself — extremely cheap.
      // This catches the .ad-showing / .ad-interrupting toggle instantly.
      adObserver = new MutationObserver(tick);
      adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }

    // Backup interval at 300ms. Catches anything the observer misses
    // without hammering the CPU.
    checkInterval = setInterval(tick, 300);
  }

  function stopObserver() {
    if (adObserver) {
      adObserver.disconnect();
      adObserver = null;
    }
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  // ─── Wait for player to exist, then attach observer ───────────────
  function waitForPlayer() {
    const player = getPlayer();
    if (player) {
      startObserver();
    } else {
      // Player not yet in DOM; wait for it
      const bodyObserver = new MutationObserver(() => {
        if (getPlayer()) {
          bodyObserver.disconnect();
          startObserver();
        }
      });
      bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────
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

  // Initial setup
  chrome.storage.local.get({ enabled: true }, (data) => {
    extensionEnabled = data.enabled;
    updateState();
  });

  // Live toggle from popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled !== undefined) {
      extensionEnabled = changes.enabled.newValue;
      updateState();
    }
  });

  // Bridge: receive ad-blocked signals from inject.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'YT_AD_SHIELD_BLOCKED') return;
    if (!extensionEnabled) return;
    incrementAdCount();
  });

  // Inject styles as early as possible
  injectStyles();

  console.log('[YT-AdShield] Content script v4.0 initialized.');
})();
