var Emitter = require('emitter');

var Audio = new Emitter();

module.exports = Audio;

// Required after the export, matching ui/accel and ui/touch: the modules below
// can require back into the ui graph.
var Platform = require('platform');
var simply = require('ui/simply');

// Only the platforms with a speaker. Everything else has the subsystem
// compiled out of the C runtime, so never send it audio.
var speakerPlatforms = ['emery', 'flint', 'gabbro'];

// Must fit one AppMessage payload (2044 - 32 overhead) alongside the packet
// header, otherwise every chunk pays for segmentation and reassembly.
var CHUNK = 1024;

// The watch grants credit in bytes consumed. Sending further ahead than the
// ring it allocated would wrap unplayed audio, so the watch is the authority
// on how far ahead we may run and this is only a ceiling for the first burst.
var MAX_AHEAD = 65536;

var state = null;

Audio.supported = function() {
  return speakerPlatforms.indexOf(Platform.version()) !== -1;
};

/**
 * Stream a clip to the watch speaker.
 *
 * @param {number[]} bytes - 4-bit IMA ADPCM, as produced by
 *   voice-dispatch/watch_audio.py. NOT mp3 or wav; the watch decodes ADPCM
 *   directly and has no room to do anything else.
 * @param {number} khz - 8 or 16. This must be the rate the SERVER actually
 *   encoded (its X-Audio-Khz response header), not the rate that was
 *   requested: playing back at the wrong rate sounds like a chipmunk rather
 *   than like an error.
 */
Audio.play = function(bytes, khz) {
  if (!Audio.supported()) {
    Audio.emit('error', { reason: 'unsupported' });
    return false;
  }
  if (!bytes || !bytes.length) {
    Audio.emit('error', { reason: 'empty' });
    return false;
  }

  Audio.stop();

  state = {
    bytes: bytes,
    sent: 0,
    credit: MAX_AHEAD,
    khz: khz === 8 ? 8 : 16,
  };

  simply.impl.audioBegin(bytes.length, state.khz);
  // The watch answers with an initial credit grant, but send the first window
  // now rather than waiting a round trip for it.
  Audio.pump();
  return true;
};

Audio.stop = function() {
  if (!state) { return; }
  state = null;
  if (Audio.supported()) {
    simply.impl.audioStop();
  }
};

Audio.playing = function() {
  return !!state;
};

/**
 * Push as much as the current credit window allows.
 */
Audio.pump = function() {
  if (!state) { return; }

  while (state.sent < state.bytes.length) {
    var ahead = state.sent - (state.consumed || 0);
    if (ahead + CHUNK > state.credit) { break; }

    var end = Math.min(state.sent + CHUNK, state.bytes.length);
    simply.impl.audioData(state.bytes.slice(state.sent, end));
    state.sent = end;
  }
};

/**
 * The watch reports how many bytes it has decoded; that re-opens the window.
 */
Audio.onCredit = function(consumed) {
  if (!state) { return; }
  state.consumed = consumed;
  Audio.pump();
};

Audio.onState = function(name, error) {
  if (name === 'playing') {
    Audio.emit('playing', {});
    return;
  }

  // Both 'done' and 'error' end the clip; drop our state before emitting so a
  // handler that immediately queues another clip is not fighting this one.
  state = null;

  if (name === 'error') {
    Audio.emit('error', { reason: error || 'unknown' });
    return;
  }
  Audio.emit('done', {});
};

/**
 * Decode a base64 payload (what the /speak route returns) into a byte array.
 *
 * pkjs has no atob, so this is a small decoder rather than a wrapper.
 */
Audio.fromBase64 = function(b64) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  var out = [];
  for (var i = 0; i < clean.length; i += 4) {
    var n = 0;
    var count = 0;
    for (var j = 0; j < 4; ++j) {
      var c = chars.indexOf(clean.charAt(i + j));
      if (c === -1) { break; }
      n = (n << 6) | c;
      count++;
    }
    // A trailing group shorter than 4 encodes fewer than 3 bytes; pad the
    // accumulator so the bytes it does carry land in the high positions.
    if (count < 2) { break; }
    n = n << (6 * (4 - count));
    out.push((n >> 16) & 0xFF);
    if (count > 2) { out.push((n >> 8) & 0xFF); }
    if (count > 3) { out.push(n & 0xFF); }
  }
  return out;
};

Audio.init = function() {
  state = null;
};

Audio.init();
