/**
 * SpeechService - speaks text aloud through the watch speaker.
 *
 * Home Assistant can synthesise speech itself, but its assist pipeline hands
 * back an mp3 URL and neither pkjs nor the watch can decode mp3 or resample it.
 * Rather than add a decoder, this reuses the voice-dispatch speech endpoint,
 * which already returns exactly what the watch speaker wants: 4-bit IMA ADPCM
 * at 8 or 16 kHz, loudness-processed for this specific tiny speaker, and cached
 * by content so repeating a phrase costs nothing.
 *
 * That endpoint needs a bearer token. It is deliberately NOT compiled in: it
 * lives in settings, so the token stays out of the source tree and out of git.
 * With no token configured, replies simply stay silent.
 */
var ajax = require('ajax');
var Audio = require('ui/audio');
var AppState = require('app/AppState');
var helpers = require('app/helpers');

var DEFAULT_BASE = 'https://voice.iccfloors.app';

// The server may answer at a different tier than requested (see X-Audio-Khz),
// so this is only an opening bid.
var REQUEST_KHZ = 16;

var SpeechService = {
    /**
     * Whether a spoken reply is possible right now.
     */
    available: function() {
        var appState = AppState.getInstance();
        return !!(appState.speak_replies && appState.speech_token && Audio.supported());
    },

    /**
     * Speak `text`, if speech is configured. Safe to call unconditionally.
     * @param {string} text
     * @param {Function} [callback] - called with (ok) once the clip finishes or fails
     */
    speak: function(text, callback) {
        var appState = AppState.getInstance();
        var log = helpers.log_message;

        if (!this.available()) {
            if (callback) { callback(false); }
            return;
        }

        var clean = String(text || '').trim();
        if (!clean) {
            if (callback) { callback(false); }
            return;
        }

        var base = appState.speech_url || DEFAULT_BASE;
        var url = base.replace(/\/+$/, '') + '/api/v2/watch/speak?q=' + REQUEST_KHZ;

        ajax(
            {
                url: url,
                method: 'POST',
                // NOT type:'json'. That would parse the response as JSON, and
                // the body is base64 text, so every successful call would be
                // reported as a failure.
                type: 'text',
                data: JSON.stringify({ text: clean }),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + appState.speech_token
                }
            },
            function(body, status, req) {
                // The endpoint reports its own failures as "ERR: ..." with a
                // 200, because the watch has no error-body plumbing.
                if (!body || body.indexOf('ERR:') === 0) {
                    log('Speech failed: ' + (body || 'empty response'));
                    if (callback) { callback(false); }
                    return;
                }

                // Trust the rate the server ACTUALLY encoded over the one we
                // asked for; a mismatch plays back at the wrong speed.
                var khz = REQUEST_KHZ;
                try {
                    var header = req.getResponseHeader('X-Audio-Khz');
                    if (header) { khz = parseInt(header, 10) || REQUEST_KHZ; }
                } catch (e) {
                    // Some runtimes refuse header reads; the default stands.
                }

                var bytes = Audio.fromBase64(body);
                if (!bytes.length) {
                    log('Speech failed: empty audio after decode');
                    if (callback) { callback(false); }
                    return;
                }

                log('Speech: ' + bytes.length + ' bytes at ' + khz + 'kHz');
                Audio.play(bytes, khz);
                if (callback) { callback(true); }
            },
            function(body, status) {
                log('Speech request failed: status ' + status);
                if (callback) { callback(false); }
            }
        );
    },

    stop: function() {
        Audio.stop();
    }
};

module.exports = SpeechService;
