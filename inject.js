/**
 * YouTube Ad Shield — API Interceptor (v5.0)
 * ==========================================
 * Runs in the MAIN execution world (page context).
 * Strips ALL ad data from YouTube's API responses before the player sees them.
 */

(function () {
  'use strict';

  // ─── All known YouTube ad-related JSON keys ───────────────────────────
  const AD_KEYS = new Set([
    // Core ad placement keys
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakParams',
    'adBreakHeartbeatParams',
    'adBreakServiceResponse',
    'adLayout',
    'adLayoutLoggingData',
    'adModule',
    'adVideoId',
    'adLoggingData',
    'adPlacementConfig',
    'adPlacementRenderer',
    'adDurationRemaining',

    // Renderer keys
    'adInfoRenderer',
    'instreamAdPlayerOverlayRenderer',
    'instreamVideoAdRenderer',
    'linearAdSequenceRenderer',
    'playerLegacyDesktopWatchAdsRenderer',
    'playerOverlayAdRenderer',
    'actionCompanionAdRenderer',
    'adHoverTextButtonRenderer',
    'adInfoDialogRenderer',
    'bumperAdRenderer',
    'displayAd',
    'displayAdRenderer',
    'invideoOverlayAdRenderer',
    'promotedSparklesWebRenderer',
    'sparklesPlayerResponse',
    'bannerPromoRenderer',

    // Companion / overlay
    'companionSlot',
    'adCompanionSlot',

    // Ad tracking / stats (pings and activeView excluded — see SAFE_KEYS)
    'adTrackingParams',
    'adRendererData',
    'adSlotLoggingData',
  ]);

  // Keys we must NEVER delete regardless of depth — deleting these breaks the player.
  // Note: these must not overlap with AD_KEYS (that check is now enforced below).
  const SAFE_KEYS = new Set([
    'playerResponse',
    'streamingData',
    'videoDetails',
    'microformat',
    'playabilityStatus',
    'playbackTracking',
    'captions',
    'storyboards',
    'pings',       // playback heartbeat — appears inside streamingData, NOT only in ads
    'activeView',  // viewability tracking used for adaptive bitrate, not just ads
  ]);

  let adBlockedCount = 0;

  function signalAdBlocked() {
    try { window.postMessage({ type: 'YT_AD_SHIELD_BLOCKED' }, window.location.origin); } catch (e) {}
  }

  // ─── Deep cleaner ─────────────────────────────────────────────────────
  function cleanObject(obj, depth, visited) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (depth > 12) return obj;
    if (visited.has(obj)) return obj;
    visited.add(obj);

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === 'object' && obj[i] !== null) {
          cleanObject(obj[i], depth + 1, visited);
        }
      }
      return obj;
    }

    let foundAd = false;
    for (const key of Object.keys(obj)) {
      if (AD_KEYS.has(key) && !SAFE_KEYS.has(key)) {
        delete obj[key];
        foundAd = true;
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        if (cleanObject(obj[key], depth + 1, visited)) foundAd = true;
      }
    }

    return foundAd;
  }

  function clean(obj) {
    const found = cleanObject(obj, 0, new WeakSet());
    if (found) {
      adBlockedCount++;
      signalAdBlocked();
    }
    return obj;
  }

  // ─── Intercept ytInitialPlayerResponse ────────────────────────────────
  let _ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get() { return _ytInitialPlayerResponse; },
      set(v) { _ytInitialPlayerResponse = (v && typeof v === 'object') ? clean(v) : v; },
      configurable: true
    });
  } catch (e) {}

  // ─── Intercept ytInitialData ───────────────────────────────────────────
  let _ytInitialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      get() { return _ytInitialData; },
      set(v) { _ytInitialData = (v && typeof v === 'object') ? clean(v) : v; },
      configurable: true
    });
  } catch (e) {}

  // ─── Intercept ytplayer config ─────────────────────────────────────────
  function cleanConfig(config) {
    if (typeof config !== 'object' || config === null) return config;
    if (config.args) {
      for (const field of ['raw_player_response', 'player_response']) {
        if (!config.args[field]) continue;
        try {
          if (typeof config.args[field] === 'string') {
            const parsed = JSON.parse(config.args[field]);
            config.args[field] = JSON.stringify(clean(parsed));
          } else {
            config.args[field] = clean(config.args[field]);
          }
        } catch (e) {}
      }
    }
    return config;
  }

  let _ytplayer;
  try {
    if (window.ytplayer) {
      _ytplayer = new Proxy(window.ytplayer, {
        set(t, p, v) {
          if (p === 'bootstrapPlayerResponse') v = clean(v);
          else if (p === 'config') v = cleanConfig(v);
          t[p] = v; return true;
        },
        get(t, p) { return t[p]; }
      });
    }
    Object.defineProperty(window, 'ytplayer', {
      get() { return _ytplayer; },
      set(v) {
        _ytplayer = (v && typeof v === 'object') ? new Proxy(v, {
          set(t, p, val) {
            if (p === 'bootstrapPlayerResponse') val = clean(val);
            else if (p === 'config') val = cleanConfig(val);
            t[p] = val; return true;
          },
          get(t, p) { return t[p]; }
        }) : v;
      },
      configurable: true
    });
  } catch (e) {}

  // ─── API URL patterns that carry ad data ──────────────────────────────
  const AD_API_PATTERNS = [
    '/youtubei/v1/player',
    '/youtubei/v1/next',
    '/youtubei/v1/ad_break',
    '/youtubei/v1/browse',
    '/youtubei/v1/search',
    '/youtubei/v1/get_watch',
  ];

  function isAdApiUrl(url) {
    if (!url) return false;
    return AD_API_PATTERNS.some(p => url.includes(p));
  }

  // ─── Intercept fetch ──────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === 'string' ? req
      : (req instanceof URL ? req.href
      : (req instanceof Request ? req.url : ''));
    if (!isAdApiUrl(url)) return _fetch.apply(this, args);

    return _fetch.apply(window, args).then(response => {
      if (!response.ok) return response;
      return response.text().then(text => {
        try {
          const json = clean(JSON.parse(text));
          text = JSON.stringify(json);
        } catch (e) {}
        // Strip encoding/length headers — body is already decompressed plain text
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      });
    });
  };

  // ─── Intercept XMLHttpRequest ──────────────────────────────────────────
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ytUrl = String(url);
      return origOpen.call(this, method, url, ...rest);
    };

    function patchXhrProp(prop) {
      const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
      if (!desc || !desc.get) return;
      Object.defineProperty(XMLHttpRequest.prototype, prop, {
        get() {
          // desc.get throws InvalidStateError when responseType is 'json' and
          // caller reads responseText — catch and re-throw so the browser's
          // native error still propagates unmodified, bypassing ad-cleaning
          // only for that case (cleaning happens via the 'response' getter instead).
          let val;
          try { val = desc.get.call(this); } catch (e) { throw e; }
          if (this.__ytUrl && isAdApiUrl(this.__ytUrl)) {
            try {
              if (typeof val === 'string') {
                val = JSON.stringify(clean(JSON.parse(val)));
              } else if (typeof val === 'object' && val !== null) {
                clean(val);
              }
            } catch (e) {}
          }
          return val;
        },
        configurable: true
      });
    }

    patchXhrProp('responseText');
    patchXhrProp('response');
  } catch (e) {}

  // ─── Intercept HTMLMediaElement.play() to mute the ad video instantly ───
  // Only applies when this element is the video INSIDE #movie_player and the
  // player itself has the ad-showing/ad-interrupting class. All other media
  // elements (miniplayer, Shorts, <audio> tags) are left completely untouched.
  const _play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      const player = document.querySelector('#movie_player');
      if (
        player &&
        player.contains(this) &&
        (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))
      ) {
        this.muted = true;
        try { this.playbackRate = 16; } catch (e) {}
      }
    } catch (e) {}
    return _play.apply(this, arguments);
  };

  console.log('[YT-AdShield] API interceptor v5.0 initialized.');
})();
