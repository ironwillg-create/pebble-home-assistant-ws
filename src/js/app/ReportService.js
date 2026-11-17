/**
 * ReportService - "Report a problem" (the Better Button), fork v2.9.
 *
 * The main menu's last row dictates a sentence and files it to Jarvis
 * (POST https://jarvis.garzas.us/api/watch/report, app "ha-watch"), where it
 * becomes an issue on ironwillg-create/homeos. The bearer token is the same
 * speech_token the spoken replies use (the Pebble token on Jarvis), so with no
 * token in Settings there is nothing to file with and the row says so.
 *
 * better.js does the work: localStorage outbox, resend on every launch, same
 * client_id on a resend so it never files twice, and its own ring of the last
 * 50 console lines. This file adds the recent app events helpers.log_message
 * has seen, which this app records even when debug logging is off.
 */
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var Better = require('app/better');
var helpers = require('app/helpers');

var NO_TOKEN = 'Set the Jarvis token in Settings';

var better = new Better({
    app: 'ha-watch',
    version: Constants.appVersion,
    token: function() {
        return AppState.getInstance().speech_token || '';
    }
});

var status = 'Say what went wrong';

var ReportService = {
    hasToken: function() {
        return !!AppState.getInstance().speech_token;
    },

    /** The words for the row's subtitle right now. */
    subtitle: function() {
        return this.hasToken() ? status : NO_TOKEN;
    },

    /**
     * Dictate and file one report. onStatus(msg) gets each new subtitle.
     */
    start: function(screen, onStatus) {
        var Voice = require('ui/voice');
        function set(msg) {
            status = msg;
            if (onStatus) { onStatus(msg); }
        }
        if (!this.hasToken()) {
            set(NO_TOKEN);
            return;
        }
        helpers.log_message('Report: dictating');
        Voice.dictate('start', true, function(e) {
            if (e.err) {
                set(e.err === 'systemAborted' ? 'Cancelled' : 'Did not catch that');
                return;
            }
            set('Sending...');
            better.file({
                text: e.transcription,
                screen: screen,
                log: helpers.recent_events().join('\n')
            }, set);
        });
    },

    /** Resend anything left in the outbox. Called once at launch. */
    drain: function() {
        better.drain();
    }
};

module.exports = ReportService;
