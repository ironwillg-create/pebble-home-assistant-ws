/* Better Button, phone side: "Report a problem" from the watch.
 *
 * The watch dictates a sentence and hands it here with the screen it came from
 * and a few lines of its own recent events. This file adds what only the phone
 * knows (watch model and firmware, a phone string, its own recent console
 * lines), saves the report to a localStorage OUTBOX, and posts it to Jarvis:
 *
 *   POST https://jarvis.garzas.us/api/watch/report   (Bearer <this app's token>)
 *
 * The outbox is the point. A report made in a dead spot must not be lost, so it
 * is written before the first attempt and only removed when the server has
 * answered for it. Every launch drains it again. A resend carries the same
 * client_id, and the server answers a repeat with its first answer and files
 * nothing new, so a retry after a lost reply can never make a duplicate issue.
 *
 * Shared, byte for byte, by the Grocery, Intake, Home Assistant WS and Craft
 * Agents watchapps (261117-nimble-gecko). Change one, change all four.
 */

var URL = 'https://jarvis.garzas.us/api/watch/report';
var OUTBOX_KEY = 'better_outbox_v1';
var MAX_OUTBOX = 10;
var MAX_AGE_MS = 7 * 24 * 3600 * 1000;
var RING_MAX = 50;

/* ---------------------------------------------------- console ring (pkjs) */

var ring = [];

/* The ring ends up in a GitHub issue's log, so anything shaped like a secret
 * (a bearer token, a JWT such as a Home Assistant token, any long opaque run of
 * token characters) is blanked before it is kept. Over-redacting a UUID now and
 * then is the cheap side of that trade. */
function redact(line) {
  return line
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_\-]{24,}(\.[A-Za-z0-9_\-]{8,}){0,2}/g, '[redacted]');
}

function remember(level, args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (typeof a === 'string') parts.push(a);
    else {
      try {
        parts.push(JSON.stringify(a));
      } catch (e) {
        parts.push(String(a));
      }
    }
  }
  var d = new Date();
  var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' +
    ('0' + d.getSeconds()).slice(-2);
  ring.push(hh + ' ' + level + ' ' + redact(parts.join(' ')).slice(0, 200));
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

function wrap(level) {
  var orig = console[level];
  if (!orig || orig.__better) return;
  var f = function () {
    remember(level, arguments);
    return orig.apply(console, arguments);
  };
  f.__better = true;
  console[level] = f;
}

wrap('log');
wrap('warn');
wrap('error');

/* ----------------------------------------------------------------- outbox */

function readBox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function writeBox(box) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
  } catch (e) {
    /* Storage full: the report still goes out this once, it just cannot wait. */
  }
}

function dropFromBox(cid) {
  var box = readBox();
  var keep = [];
  for (var i = 0; i < box.length; i++) if (box[i].client_id !== cid) keep.push(box[i]);
  writeBox(keep);
}

function newClientId() {
  var abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var s = 'w' + Date.now().toString(36) + '-';
  for (var i = 0; i < 10; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return s;
}

function watchString() {
  try {
    var w = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
    if (!w) return '';
    var fw = w.firmware || {};
    var ver = [fw.major, fw.minor, fw.patch].join('.') + (fw.suffix ? '-' + fw.suffix : '');
    return [w.model || w.platform || 'pebble', w.platform || '', 'fw ' + ver].join(' ').slice(0, 80);
  } catch (e) {
    return '';
  }
}

function phoneString() {
  try {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    return (ua || 'unknown phone').slice(0, 80);
  } catch (e) {
    return 'unknown phone';
  }
}

/* --------------------------------------------------------------- transport */

/* status(msg) is called once per report with the words for the watch row. */
function post(entry, token, status) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', URL, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.setRequestHeader('Content-Type', 'application/json');
  try {
    /* Cloudflare 403s some default agents. Some phone JS engines refuse to set
     * this header; that is fine, the try keeps the post going without it. */
    xhr.setRequestHeader('User-Agent', 'PebbleWatchReport/1 (' + entry.app + ')');
  } catch (e) {}
  xhr.timeout = 20000;
  xhr.onload = function () {
    var d = {};
    try {
      d = JSON.parse(xhr.responseText) || {};
    } catch (e) {}
    var s = xhr.status;
    if (s === 200 || s === 202) {
      dropFromBox(entry.client_id);
      if (d.issue_number) return status('Sent #' + d.issue_number);
      return status(d.queued ? 'Sent, filing soon' : 'Sent');
    }
    if (s === 400 || s === 403) {
      /* The server will never take this one. Drop it and say why. */
      dropFromBox(entry.client_id);
      return status(String(d.error || 'Refused ' + s).slice(0, 40));
    }
    if (s === 401) return status('Token not accepted, saved');
    if (s === 429) return status('Too many reports, saved');
    status('Saved, will resend');
  };
  xhr.onerror = function () {
    status('Saved, will resend');
  };
  xhr.ontimeout = function () {
    status('Saved, will resend');
  };
  xhr.send(JSON.stringify(entry));
}

/* opts: {app, version, token: function () -> string}
 * The token function may return '' when the app has none configured yet; the
 * report is still saved and goes out on a later launch once there is one. */
function Better(opts) {
  this.app = opts.app;
  this.version = opts.version;
  this.token = opts.token;
}

/* Build, save and send one report. r: {text, screen, log (string, '\n' lines)}.
 * status(msg) gets the words to show on the watch row. */
Better.prototype.file = function (r, status) {
  var text = String(r.text || '').trim();
  if (!text) return status('Did not catch that');
  var watchLines = String(r.log || '').split('\n').filter(function (l) {
    return l;
  });
  var log = [];
  for (var i = 0; i < watchLines.length; i++) log.push('watch ' + redact(watchLines[i]));
  for (var j = 0; j < ring.length; j++) log.push('js ' + ring[j]);
  var entry = {
    app: this.app,
    text: text.slice(0, 4000),
    client_id: newClientId(),
    kind: 'bug',
    app_version: this.version,
    screen: String(r.screen || '').slice(0, 80),
    watch: watchString(),
    phone: phoneString(),
    log: log,
    saved_at: Date.now()
  };
  var box = readBox();
  box.push(entry);
  if (box.length > MAX_OUTBOX) box = box.slice(box.length - MAX_OUTBOX);
  writeBox(box);
  var token = this.token();
  if (!token) return status('Saved, no token yet');
  console.log('better: filing report ' + entry.client_id);
  post(entry, token, status);
};

/* Resend anything left over from an earlier launch. Quiet unless asked. */
Better.prototype.drain = function (status) {
  var token = this.token();
  if (!token) return;
  var now = Date.now();
  var box = readBox().filter(function (e) {
    return now - (e.saved_at || now) < MAX_AGE_MS;
  });
  writeBox(box);
  for (var i = 0; i < box.length; i++) {
    if (box[i].app !== this.app) continue;
    console.log('better: resending ' + box[i].client_id);
    post(box[i], token, status || function () {});
  }
};

module.exports = Better;
