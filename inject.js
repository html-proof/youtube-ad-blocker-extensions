/**
 * YouTube Ad Shield — MAIN World Script (v6.0)
 * =============================================
 * Strategy: do NOT strip API responses (triggers YouTube's anti-adblock
 * detection which pauses playback). Instead:
 *   1. Intercept play() to mute/speed the ad video instantly.
 *   2. Neutralise the ad-break heartbeat so YouTube thinks the ad was watched.
 */

(function () {
  'use strict';

  // ─── Mute + speed-up any video play() call that happens during an ad ─────
  // Only applies to the video INSIDE #movie_player to avoid affecting Shorts,
  // miniplayer, or background audio.
  const _play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      const player = document.querySelector('#movie_player');
      if (
        player &&
        player.contains(this) &&
        (player.classList.contains('ad-showing') ||
          player.classList.contains('ad-interrupting'))
      ) {
        this.muted = true;
        try { this.playbackRate = 16; } catch (_) {}
      }
    } catch (_) {}
    return _play.apply(this, arguments);
  };

  // ─── Block ad-break / ad-stat network calls ──────────────────────────────
  // We block the reporting calls only (not the player API), so YouTube never
  // learns that we skipped the ad, and anti-adblock checks pass.
  const AD_STAT_PATTERNS = [
    '/api/stats/ads',
    '/api/stats/ads_log',
    '/youtubei/v1/ad_break',
    '/pagead/',
    '/ptracking',
    'googleads.g.doubleclick.net',
    'pubads.g.doubleclick.net',
  ];

  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req
      : (req instanceof URL ? req.href
      : (req instanceof Request ? req.url : ''));
    if (AD_STAT_PATTERNS.some(p => url.includes(p))) {
      // Return an empty 200 so YouTube's retry logic stays happy
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return _fetch.apply(this, args);
  };

  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytAdUrl = AD_STAT_PATTERNS.some(p => String(url).includes(p));
    return _xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytAdUrl) {
      // Fake a successful empty response so YouTube doesn't retry
      Object.defineProperty(this, 'readyState', { get: () => 4, configurable: true });
      Object.defineProperty(this, 'status', { get: () => 200, configurable: true });
      Object.defineProperty(this, 'responseText', { get: () => '{}', configurable: true });
      return;
    }
    return _xhrSend.apply(this, args);
  };

  console.log('[YT-AdShield] inject v6.0 ready.');
})();
