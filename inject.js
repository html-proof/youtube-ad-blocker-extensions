/**
 * YouTube Ad Shield — API Interceptor (v4.1)
 * ==========================================
 * Runs in the MAIN execution world (page context).
 * Strips ad data from YouTube's API responses before the player sees them.
 * Does NOT touch Object.prototype (YouTube detects and works around that).
 */

(function () {
  'use strict';

  // ─── All known YouTube ad-related JSON keys ──────────────────────
  const AD_KEYS = new Set([
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakParams',
    'adBreakHeartbeatParams',
    'adLayout',
    'adLayoutLoggingData',
    'adInfoRenderer',
    'adModule',
    'adVideoId',
    'instreamAdPlayerOverlayRenderer',
    'linearAdSequenceRenderer',
    'playerLegacyDesktopWatchAdsRenderer',
    'actionCompanionAdRenderer',
    'adHoverTextButtonRenderer',
    'adInfoDialogRenderer',
    'bannerPromoRenderer',
    'promotedSparklesWebRenderer',
    'sparklesPlayerResponse',
    'playerResponse',           // only deleted inside adPlacements context
    'invideoOverlayAdRenderer',
  ]);

  // Keys we must never touch even if they look ad-related
  const SAFE_KEYS = new Set([
    'playerResponse',   // top-level playerResponse is critical
  ]);

  // Signal content.js that an ad was intercepted
  function signalAdBlocked() {
    try {
      window.postMessage({ type: 'YT_AD_SHIELD_BLOCKED' }, '*');
    } catch (e) {}
  }

  // ─── Deep cleaner ────────────────────────────────────────────────
  function cleanObject(obj, depth, visited) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (depth > 8) return obj; // ad keys live in top levels only
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
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (AD_KEYS.has(key) && !SAFE_KEYS.has(key)) {
        delete obj[key];
        foundAd = true;
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        cleanObject(obj[key], depth + 1, visited);
      }
    }
    if (foundAd && depth === 0) signalAdBlocked();
    return obj;
  }

  function clean(obj) {
    return cleanObject(obj, 0, new WeakSet());
  }

  // ─── Intercept ytInitialPlayerResponse ───────────────────────────
  let _ytInitialPlayerResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get() { return _ytInitialPlayerResponse; },
      set(value) {
        _ytInitialPlayerResponse = (typeof value === 'object' && value !== null)
          ? clean(value) : value;
      },
      configurable: true
    });
  } catch (e) {}

  // ─── Intercept ytInitialData ─────────────────────────────────────
  let _ytInitialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      get() { return _ytInitialData; },
      set(value) {
        _ytInitialData = (typeof value === 'object' && value !== null)
          ? clean(value) : value;
      },
      configurable: true
    });
  } catch (e) {}

  // ─── Intercept ytplayer config ───────────────────────────────────
  let _ytplayer;
  function cleanConfig(config) {
    if (typeof config !== 'object' || config === null) return config;
    if (config.args) {
      for (const field of ['raw_player_response', 'player_response']) {
        if (config.args[field]) {
          try {
            if (typeof config.args[field] === 'string') {
              let parsed = JSON.parse(config.args[field]);
              config.args[field] = JSON.stringify(clean(parsed));
            } else {
              config.args[field] = clean(config.args[field]);
            }
          } catch (e) {}
        }
      }
    }
    return config;
  }

  function wrapYtplayer(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    return new Proxy(obj, {
      set(target, prop, value) {
        if (prop === 'bootstrapPlayerResponse') value = clean(value);
        else if (prop === 'config') value = cleanConfig(value);
        target[prop] = value;
        return true;
      },
      get(target, prop) { return target[prop]; }
    });
  }

  try {
    if (window.ytplayer) _ytplayer = wrapYtplayer(window.ytplayer);
    Object.defineProperty(window, 'ytplayer', {
      get() { return _ytplayer; },
      set(value) { _ytplayer = wrapYtplayer(value); },
      configurable: true
    });
  } catch (e) {}

  // ─── Intercept fetch ─────────────────────────────────────────────
  const AD_API_PATTERNS = ['/youtubei/v1/player', '/youtubei/v1/next', '/youtubei/v1/ad_break'];
  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : (request instanceof Request ? request.url : '');

    const isAdApi = AD_API_PATTERNS.some(p => url.includes(p));
    if (!isAdApi) return originalFetch.apply(this, args);

    return originalFetch.apply(window, args).then(response => {
      if (!response.ok) return response;
      return response.text().then(text => {
        try {
          let json = JSON.parse(text);
          json = clean(json);
          text = JSON.stringify(json);
        } catch (e) {}

        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      });
    });
  };

  // ─── Intercept XMLHttpRequest ────────────────────────────────────
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__url = url;
      return origOpen.apply(this, arguments);
    };

    const descText = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    if (descText && descText.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
        get() {
          let text = descText.get.call(this);
          if (this.__url && AD_API_PATTERNS.some(p => this.__url.includes(p))) {
            try {
              let json = JSON.parse(text);
              json = clean(json);
              text = JSON.stringify(json);
            } catch (e) {}
          }
          return text;
        },
        configurable: true
      });
    }

    const descResp = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (descResp && descResp.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        get() {
          let res = descResp.get.call(this);
          if (this.__url && AD_API_PATTERNS.some(p => this.__url.includes(p))) {
            try {
              if (typeof res === 'string') {
                let json = JSON.parse(res);
                res = JSON.stringify(clean(json));
              } else if (typeof res === 'object' && res !== null) {
                res = clean(res);
              }
            } catch (e) {}
          }
          return res;
        },
        configurable: true
      });
    }
  } catch (e) {}

  // ─── Playback overrides REMOVED ────────────────────────────────────
  // Previously we overrode HTMLMediaElement.prototype.playbackRate, .muted,
  // and .play() to force 16x speed during ads. This was REMOVED because
  // YouTube reuses the same <video> element for both ads and content.
  // During the ad→content transition, these overrides would briefly apply
  // to the real video, causing it to jump 15-20 seconds ahead.
  //
  // Ad blocking is now handled safely by:
  //   1. API interceptor (fetch/XHR) strips ad data before the player sees it
  //   2. content.js mutes the video and clicks skip buttons
  //   3. CSS hides ad overlays and banners

  console.log('[YT-AdShield] API interceptor v4.1 initialized.');
})();
