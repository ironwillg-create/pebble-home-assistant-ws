"""Fork the upstream Clay config page, adding the ICC fork's own settings.

Upstream's page (config/v1.2.html) is a 60 KB hand-rolled form, and the app can
only point at ONE config URL, so the extra settings have to live inside a copy
of it rather than on a page of their own. This does three surgical insertions
instead of hand-editing the file, so re-forking against a newer upstream is a
re-run rather than a merge.

Every anchor is asserted before use: a silent no-op here would ship a config
page that looks right and quietly drops the new settings.
"""

import io
import os
import sys

SRC = os.path.join(os.path.dirname(__file__), "ha-ws", "config", "v1.2.html")
DST = os.path.join(os.path.dirname(__file__), "ha-ws", "config", "v2.2-icc.html")

# --- 1. The form markup, inserted after the Access Token component ----------

ANCHOR_HTML = """					<small class="form-text">You can obtain a token ("Long-Lived Access Token") by logging into the frontend using a web browser, and going to your profile.</small>
				</div>
			</div>
			</div>
		</div>"""

# The anchor above is deliberately re-derived below from the real file, because
# the indentation in this source is easy to get subtly wrong.
ANCHOR_HTML = """						<small class="form-text">You can obtain a token ("Long-Lived Access Token") by logging into the frontend using a web browser, and going to your profile.</small>
					</div>
				</div>
			</div>
		</div>"""

NEW_HTML = ANCHOR_HTML + """

		<!-- ICC fork: watch dashboard + spoken replies -->
		<div class="section">
			<div class="section-header">Watch Dashboard (ICC fork)</div>
			<div class="section-body">
				<div class="component">
					<div class="form-group">
						<label class="form-label" for="icc-dashboard-entity">Dashboard entity</label>
						<input type="text" class="form-control" id="icc-dashboard-entity" placeholder="sensor.pebble_dashboard">
						<small class="form-text">The Home Assistant entity whose <code>screens</code> attribute defines the tile screens. Leave blank for <code>sensor.pebble_dashboard</code>.</small>
					</div>
				</div>
			</div>
		</div>

		<div class="section">
			<div class="section-header">Spoken Replies (ICC fork)</div>
			<div class="section-body">
				<div class="component">
					<div class="form-switch">
						<label class="form-check-label" for="icc-speak-replies">Read answers aloud</label>
						<input class="form-check-input" type="checkbox" id="icc-speak-replies">
					</div>
					<small class="form-text">Speaks the Assistant's answer through the watch speaker. Needs a speech service URL and token below; without them this stays silent.</small>
				</div>
				<div class="component">
					<div class="form-group">
						<label class="form-label" for="icc-speech-url">Speech service URL</label>
						<input type="url" class="form-control" id="icc-speech-url" placeholder="https://voice.iccfloors.app">
						<small class="form-text">Base URL only. The app calls <code>/api/v2/watch/speak</code> on it.</small>
					</div>
				</div>
				<div class="component">
					<div class="form-group">
						<label class="form-label" for="icc-speech-token">Speech service token</label>
						<div class="input-group">
							<input type="password" class="form-control" id="icc-speech-token" placeholder="">
							<button class="btn btn-outline-secondary" type="button" id="toggle-speech-token-visibility">
								<i class="fa fa-eye" id="toggle-speech-token-icon"></i>
							</button>
						</div>
						<small class="form-text">Bearer token for the speech service. Stored as a watch setting, never compiled into the app.</small>
					</div>
				</div>
			</div>
		</div>"""

# --- 2. Read the values back out on save -----------------------------------

ANCHOR_VALUES = """				'token': tokenInput.val(),"""

NEW_VALUES = ANCHOR_VALUES + """
				// ICC fork settings
				'dashboard_entity': $('#icc-dashboard-entity').val() || 'sensor.pebble_dashboard',
				'speak_replies': $('#icc-speak-replies').is(':checked'),
				'speech_url': $('#icc-speech-url').val() || 'https://voice.iccfloors.app',
				'speech_token': $('#icc-speech-token').val() || null,"""

# --- 3. Populate the form from the settings the watch sent us --------------

ANCHOR_POPULATE = """			if(watch_config['token']) {
				tokenInput.val(watch_config['token']);
			}"""

NEW_POPULATE = ANCHOR_POPULATE + """
			// ICC fork settings
			if (watch_config['dashboard_entity']) {
				$('#icc-dashboard-entity').val(watch_config['dashboard_entity']);
			}
			$('#icc-speak-replies').attr('checked', watch_config['speak_replies'] === true);
			if (watch_config['speech_url']) {
				$('#icc-speech-url').val(watch_config['speech_url']);
			}
			if (watch_config['speech_token']) {
				$('#icc-speech-token').val(watch_config['speech_token']);
			}
			$('#toggle-speech-token-visibility').click(function() {
				const field = $('#icc-speech-token');
				const isPassword = field.attr('type') === 'password';
				field.attr('type', isPassword ? 'text' : 'password');
				$('#toggle-speech-token-icon').toggleClass('fa-eye fa-eye-slash');
			});"""


def main():
    with io.open(SRC, encoding="utf-8") as fh:
        html = fh.read()

    for label, anchor, replacement in (
        ("form markup", ANCHOR_HTML, NEW_HTML),
        ("getFormValues", ANCHOR_VALUES, NEW_VALUES),
        ("populate", ANCHOR_POPULATE, NEW_POPULATE),
    ):
        count = html.count(anchor)
        if count != 1:
            print(f"FAIL: {label} anchor matched {count} times, expected exactly 1")
            return 1
        html = html.replace(anchor, replacement)

    # The page announces its own version in a few places; make it obvious this
    # is the fork so a stale cached copy is identifiable at a glance.
    html = html.replace("<title>", "<title>ICC fork &mdash; ", 1)

    with io.open(DST, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(html)

    print(f"wrote {DST} ({len(html)} bytes)")
    for needle in ("icc-speech-token", "speak_replies", "dashboard_entity", "icc-dashboard-entity"):
        print(f"  contains {needle}: {html.count(needle)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
