/**
 * DashboardPage - Tile grid screens defined in Home Assistant.
 *
 * The whole point of this page is that it is NOT hardcoded. The layout lives in
 * an HA entity's attributes (sensor.pebble_dashboard by default), so screens can
 * be rearranged by editing YAML in Home Assistant without rebuilding and
 * sideloading the watchapp.
 *
 * Expected shape:
 *
 *   screens:
 *     - title: Home
 *       layout: "2x3"          # cols x rows
 *       tiles:
 *         - label: Kitchen
 *           entity: light.kitchen
 *           action: toggle
 *         - label: Goodnight
 *           action: script.goodnight
 *         - label: Garage
 *           entity: cover.garage
 *           action: toggle
 *           confirm: true
 *
 * Tiles with an `entity` render live state and colour from it. Tiles without one
 * are pure shortcuts. Every tile is reachable three ways: tap it, or move the
 * selection with up/down and press select. Touch is additive, never the only way
 * in, because the emulator cannot inject touch events and because buttons still
 * work with gloves on.
 */
var UI = require('ui');
var Vector2 = require('vector2');
var Feature = require('platform/feature');
var Vibe = require('ui/vibe');
var AppState = require('app/AppState');
var Constants = require('app/Constants');
var helpers = require('app/helpers');
var BasePage = require('app/pages/BasePage');

var DEFAULT_DASHBOARD_ENTITY = 'sensor.pebble_dashboard';

var HEADER_H = 24;
var GAP = 4;

// Thick enough to read at arm's length without shrinking the tile's usable
// area; 2 px was reported as too subtle to find the cursor.
var SELECT_BORDER = 4;

// Rounded tiles. The C renderer fills rects with graphics_fill_rect(radius,
// GCornersAll), so this costs nothing extra to draw.
var TILE_RADIUS = 6;

// Screen position is shown as dots rather than "2/5": at this size a reader
// takes in "which of these am I on" faster than they parse a fraction.
var DOT_R = 3;
var DOT_GAP = 9;

// How long an armed confirm tile stays armed before it forgets. Long enough to
// press twice deliberately, short enough that a pocket press later does nothing.
var CONFIRM_MS = 4000;

var colours = {
  bg: 'black',
  // A dark header instead of the old bright blue bar: the tiles are the
  // content, and a saturated strip across the top pulled the eye away from
  // them and clashed with the green "on" state.
  // Built around green rather than the teal/blue it started with. The Pebble
  // palette is a fixed 64-colour cube, so these are the nearest members of it:
  // asking for an arbitrary hex silently snaps to whatever is closest anyway.
  header: Feature.color('#005500', 'black'),
  headerText: Feature.color('white', 'white'),
  headerAccent: Feature.color('#AAFF55', 'white'),
  tile: Feature.color('#555555', 'black'),
  tileOn: Feature.color('#00AA55', 'white'),
  tileUnavailable: Feature.color('#AA0000', 'black'),
  tileArmed: Feature.color('#FFAA00', 'white'),
  error: Feature.color('#FF5500', 'black'),
  text: Feature.color('white', 'white'),
  textOn: Feature.color('white', 'black'),
  // White reads against every tile state (grey off, green on, red
  // unavailable, amber armed); a coloured frame vanished against whichever
  // state happened to be near it.
  select: Feature.color('white', 'white'),
  textMuted: Feature.color('#AAAAAA', 'white'),
};

// States that mean "this thing is on right now". Everything else is treated as
// off for colouring purposes.
var ON_STATES = ['on', 'open', 'unlocked', 'playing', 'cleaning', 'home', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

var isOn = function(state) {
  return ON_STATES.indexOf(state) !== -1;
};

var isUnavailable = function(state) {
  return state === 'unavailable' || state === 'unknown';
};

// Raw HA states are snake_case machine strings that neither fit a tile nor read
// well ("armed_home" clipped to "armed_ho" on a real watch). Tiles can override
// any of this with their own `map`.
var STATE_WORDS = {
  'armed_home': 'Armed',
  'armed_away': 'Away',
  'armed_night': 'Night',
  'armed_vacation': 'Vac',
  'disarmed': 'Off',
  'triggered': 'ALARM',
  'pending': 'Pending',
  'arming': 'Arming',
  'not_home': 'Away',
  'home': 'Home',
  'on': 'On',
  'off': 'Off',
  'open': 'Open',
  'closed': 'Shut',
  'docked': 'Docked',
  'charging': 'Charge',
  'cleaning': 'Clean',
  'returning': 'Return',
  'idle': 'Idle',
  'paused': 'Paused',
  'up': 'Up',
  'down': 'DOWN',
  'ready': 'Ready',
  'run': 'Running',
  'unavailable': '-',
  'unknown': '-',
};

// Anything wider than this in the big value font will clip, so the renderer
// steps down a size rather than truncating mid-word.
var VALUE_WIDE_CHARS = 7;

var formatValue = function(raw, tile) {
  var value = (raw === undefined || raw === null) ? '' : String(raw);

  if (tile && tile.map && tile.map[value] !== undefined) {
    return String(tile.map[value]);
  }

  var key = value.toLowerCase();
  if (STATE_WORDS[key] !== undefined) {
    return STATE_WORDS[key];
  }

  // Numbers are usually the interesting part; drop noise decimals.
  var asNumber = parseFloat(value);
  if (!isNaN(asNumber) && String(asNumber) === value.trim() && value.indexOf('.') !== -1) {
    return String(Math.round(asNumber * 10) / 10);
  }

  return value.replace(/_/g, ' ');
};

class DashboardPage extends BasePage {
    constructor(options) {
        super(options);
        this.screens = [];
        this.screenIndex = 0;
        this.tileIndex = 0;
        this.tileViews = [];
        this.armed = null;
        this.armedTimer = null;
        this.headerText = null;
        this.pickedDefault = false;
        this.screensKey = null;
        this.flashTimer = null;
    }

    createMenu() {
        var wind = new UI.Window({
            backgroundColor: colours.bg,
            // Non-scrolling on purpose: Pebble.js does not report the scroll
            // offset back to JS, so on a scrolled window a tap coordinate could
            // not be mapped to the right tile.
            scrollable: false,
        });
        return wind;
    }

    setupEventHandlers() {
        var self = this;
        var wind = this.menu;

        wind.on('show', function() { self.onShow(); });
        wind.on('hide', function() { self.onHide(); });

        wind.on('click', 'up', function() { self.moveSelection(-1); });
        wind.on('click', 'down', function() { self.moveSelection(1); });
        wind.on('click', 'select', function() { self.activate(self.tileIndex); });
        wind.on('longClick', 'select', function() { self.reload(); });

        // Touch. Registering these is also what powers the digitizer on.
        wind.on('tap', function(e) { self.onTap(e); });
        wind.on('swipe', function(e) { self.onSwipe(e); });
    }

    onShow() {
        this.loadScreens();
    }

    onHide() {
        this.disarm();
        this.unsubscribe();
        if (this.flashTimer) {
            clearTimeout(this.flashTimer);
            this.flashTimer = null;
        }
    }

    /**
     * Pulls the screen definitions out of the configured HA entity's attributes.
     */
    loadScreens() {
        var self = this;
        var appState = this.appState;
        var entityId = appState.dashboard_entity || DEFAULT_DASHBOARD_ENTITY;

        var entity = appState.ha_state_dict ? appState.ha_state_dict[entityId] : null;
        if (!entity || !entity.attributes || !entity.attributes.screens) {
            return this.showEmpty(entityId);
        }

        var screens = entity.attributes.screens;
        if (typeof screens === 'string') {
            // HA templates that build the list as a JSON string rather than a
            // native list are common enough to be worth accepting.
            try {
                screens = JSON.parse(screens);
            } catch (e) {
                helpers.log_message('Dashboard: screens attribute is not valid JSON: ' + e);
                return this.showEmpty(entityId);
            }
        }
        if (!screens || !screens.length) {
            return this.showEmpty(entityId);
        }

        this.screens = screens;
        // Remember what we rendered, so the subscription can tell a definition
        // change from an ordinary state tick. Without this the first update
        // after every load would look like a change and rebuild the screen.
        this.screensKey = JSON.stringify(entity.attributes.screens);

        // Home Assistant decides which screen matters right now. It can add or
        // drop whole screens (a Print screen only while something is printing)
        // and name the one to open on, so "what the watch shows first" is
        // template logic in HA rather than something baked into the app.
        //
        // Only honoured on the first render: after that the cursor belongs to
        // whoever is holding the watch, and yanking them to another screen
        // mid-scroll because a sensor changed would be hostile.
        if (!this.pickedDefault) {
            this.pickedDefault = true;
            var wanted = entity.attributes.default_screen;
            var index = this.indexOfScreen(wanted);
            if (index !== -1) { this.screenIndex = index; }
        }

        if (this.screenIndex >= this.screens.length) {
            this.screenIndex = 0;
        }
        this.render();
        this.subscribeToScreen();
    }

    reload() {
        var self = this;
        var StateService = require('app/StateService');
        Vibe.vibrate('short');
        StateService.refresh(function() {
            self.loadScreens();
        });
    }

    showEmpty(entityId) {
        this.clearElements();
        var wind = this.menu;
        var size = wind.size();
        var text = new UI.Text({
            position: new Vector2(6, 30),
            size: new Vector2(size.x - 12, size.y - 40),
            text: 'No dashboard found.\n\nAdd ' + entityId + ' in Home Assistant with a `screens` attribute.',
            font: 'gothic-18',
            color: colours.text,
            textAlign: 'left',
        });
        wind.add(text);
        this.tileViews = [];
    }

    clearElements() {
        var wind = this.menu;
        var items = wind._items.slice();
        for (var i = 0; i < items.length; ++i) {
            wind.remove(items[i]);
        }
        this.tileViews = [];
        this.headerText = null;
    }

    currentScreen() {
        return this.screens[this.screenIndex];
    }

    /**
     * Resolves a default_screen hint, which may be a title or a 0-based index.
     * @returns {number} the screen index, or -1 if it does not match one.
     */
    indexOfScreen(wanted) {
        if (wanted === undefined || wanted === null) { return -1; }

        if (typeof wanted === 'number') {
            return (wanted >= 0 && wanted < this.screens.length) ? wanted : -1;
        }

        var name = String(wanted).toLowerCase();
        for (var i = 0; i < this.screens.length; ++i) {
            if (String(this.screens[i].title || '').toLowerCase() === name) {
                return i;
            }
        }
        // A numeric string is a reasonable thing for a template to emit.
        var asNumber = parseInt(wanted, 10);
        if (!isNaN(asNumber) && asNumber >= 0 && asNumber < this.screens.length) {
            return asNumber;
        }
        return -1;
    }

    /**
     * Parses a "COLSxROWS" layout string, falling back to a 2x3 grid.
     */
    gridFor(screen) {
        var cols = 2;
        var rows = 3;
        if (screen && typeof screen.layout === 'string') {
            var parts = screen.layout.toLowerCase().split('x');
            var c = parseInt(parts[0], 10);
            var r = parseInt(parts[1], 10);
            if (c > 0 && r > 0) {
                cols = c;
                rows = r;
            }
        }
        return { cols: cols, rows: rows };
    }

    render() {
        this.clearElements();

        var wind = this.menu;
        var screen = this.currentScreen();
        if (!screen) { return; }

        var size = wind.size();
        var grid = this.gridFor(screen);
        var tiles = (screen.tiles || []).slice(0, grid.cols * grid.rows);

        if (this.tileIndex >= tiles.length) {
            this.tileIndex = 0;
        }

        // Header: title on the left, one dot per screen on the right. Dots beat
        // "2/5" here - at a glance you read position from the filled dot
        // without parsing a fraction - and they also advertise that there ARE
        // other screens, which a number does less well.
        var headerBg = new UI.Rect({
            position: new Vector2(0, 0),
            size: new Vector2(size.x, HEADER_H),
            backgroundColor: colours.header,
        });
        wind.add(headerBg);

        var dotsWidth = (this.screens.length > 1)
            ? this.screens.length * DOT_GAP + 4 : 0;

        this.headerText = new UI.Text({
            position: new Vector2(6, 2),
            size: new Vector2(size.x - 12 - dotsWidth, HEADER_H),
            text: screen.title || 'Dashboard',
            font: 'gothic-18-bold',
            color: colours.headerText,
            textAlign: 'left',
        });
        wind.add(this.headerText);

        if (this.screens.length > 1) {
            var dotsX = size.x - dotsWidth;
            for (var d = 0; d < this.screens.length; ++d) {
                var isHere = (d === this.screenIndex);
                wind.add(new UI.Circle({
                    position: new Vector2(dotsX + d * DOT_GAP + DOT_R, HEADER_H / 2),
                    radius: isHere ? DOT_R : DOT_R - 1,
                    backgroundColor: isHere ? colours.headerAccent : colours.textMuted,
                }));
            }
        }

        var gridH = size.y - HEADER_H;
        var tileW = Math.floor((size.x - GAP * (grid.cols + 1)) / grid.cols);
        var tileH = Math.floor((gridH - GAP * (grid.rows + 1)) / grid.rows);

        for (var i = 0; i < tiles.length; ++i) {
            var col = i % grid.cols;
            var row = Math.floor(i / grid.cols);
            var x = GAP + col * (tileW + GAP);
            var y = HEADER_H + GAP + row * (tileH + GAP);

            var rect = new UI.Rect({
                position: new Vector2(x, y),
                size: new Vector2(tileW, tileH),
                backgroundColor: colours.tile,
                borderColor: 'clear',
                borderWidth: 0,
                // Set at construction because Rect exposes no radius accessor;
                // tiles are rebuilt on every render, so nothing needs to change
                // it in place.
                radius: TILE_RADIUS,
            });
            wind.add(rect);

            var label = new UI.Text({
                position: new Vector2(x + 4, y + 4),
                size: new Vector2(tileW - 8, tileH - 8),
                text: tiles[i].label || tiles[i].entity || '?',
                font: 'gothic-18-bold',
                color: colours.text,
                textAlign: 'center',
            });
            wind.add(label);

            // A value tile exists to be READ, so it inverts the usual
            // hierarchy: the reading is the big text and the label shrinks to a
            // caption above it. A toggle tile is the other way round, because
            // there the thing you are aiming at is the name.
            var isValue = (tiles[i].type === 'value');
            if (isValue) {
                label.font('gothic-14');
                label.size(new Vector2(tileW - 6, 16));
            }

            var stateText = new UI.Text({
                position: isValue ? new Vector2(x + 3, y + 16)
                                  : new Vector2(x + 3, y + tileH - 20),
                size: new Vector2(tileW - 6, isValue ? tileH - 18 : 18),
                text: '',
                font: isValue ? 'gothic-24-bold' : 'gothic-14',
                color: colours.text,
                textAlign: 'center',
            });
            wind.add(stateText);

            this.tileViews.push({
                tile: tiles[i],
                rect: rect,
                label: label,
                stateText: stateText,
            });
        }

        this.refreshTiles();
    }

    /**
     * Repaints every tile from current entity state plus selection/armed state.
     */
    refreshTiles() {
        var stateDict = this.appState.ha_state_dict || {};

        for (var i = 0; i < this.tileViews.length; ++i) {
            var view = this.tileViews[i];
            var tile = view.tile;
            var background = colours.tile;
            var textColour = colours.text;
            var stateLabel = '';

            if (tile.entity) {
                var entity = stateDict[tile.entity];
                var state = entity ? entity.state : 'unavailable';
                var raw = state;

                // A value tile can show an attribute instead of the state, so
                // "time left" can come off a printer without needing a template
                // sensor per field.
                if (tile.attribute && entity && entity.attributes) {
                    var attr = entity.attributes[tile.attribute];
                    raw = (attr === undefined || attr === null) ? '' : attr;
                }

                stateLabel = formatValue(raw, tile);
                if (tile.unit && !isUnavailable(state) && stateLabel !== '-') {
                    stateLabel += tile.unit;
                }

                if (isUnavailable(state)) {
                    background = colours.tileUnavailable;
                } else if (tile.type === 'value') {
                    // Readings are not "on"; colouring them green would imply a
                    // state they do not have. `alert` marks the values that ARE
                    // worth shouting about (a door left open, a service down).
                    background = (tile.alert && String(state) === String(tile.alert))
                        ? colours.tileUnavailable : colours.tile;
                } else if (isOn(state)) {
                    background = colours.tileOn;
                    textColour = colours.textOn;
                }

                // Long words clip in the big value font, so step down a size
                // rather than cutting a word in half.
                if (tile.type === 'value') {
                    view.stateText.font(stateLabel.length > VALUE_WIDE_CHARS
                        ? 'gothic-18-bold' : 'gothic-24-bold');
                }
            }

            if (this.armed === i) {
                background = colours.tileArmed;
                textColour = colours.textOn;
                stateLabel = 'confirm?';
            }

            // Selection is a thick bright frame and nothing else.
            //
            // It used to also prefix the value with a caret. That character has
            // no glyph in the watch's font, so every selected tile rendered a
            // hollow box - the app's own font cannot be assumed to have
            // anything outside plain ASCII, so nothing here uses a symbol.
            //
            // Deliberately NOT done by recolouring the tile: the background
            // carries whether the thing is on or off, and overwriting it would
            // make a selected lamp that is on look identical to one that is
            // off. Selection is chrome; state is information.
            var selected = (i === this.tileIndex);

            // The label is deliberately quieter than the value, but only on the
            // plain grey tile. Muted grey on a saturated green or red loses too
            // much contrast to read at a glance, so a coloured tile gets a
            // full-strength label.
            var quietLabel = (background === colours.tile) && !selected;

            view.rect.backgroundColor(background);
            view.rect.borderColor(selected ? colours.select : 'clear');
            view.rect.borderWidth(selected ? SELECT_BORDER : 0);
            view.label.color(quietLabel ? colours.textMuted : textColour);
            view.stateText.color(textColour);
            view.stateText.text(stateLabel);
        }
    }

    /**
     * Live updates for exactly the entities on the visible screen.
     */
    subscribeToScreen() {
        var self = this;
        var ids = [];
        for (var i = 0; i < this.tileViews.length; ++i) {
            var entity = this.tileViews[i].tile.entity;
            if (entity && ids.indexOf(entity) === -1) {
                ids.push(entity);
            }
        }

        // Watch the dashboard entity itself as well, so screens that HA adds or
        // drops (a Print screen appearing when a print starts) show up without
        // anyone pressing refresh.
        var dashboardId = this.appState.dashboard_entity || DEFAULT_DASHBOARD_ENTITY;
        if (ids.indexOf(dashboardId) === -1) {
            ids.push(dashboardId);
        }

        if (!ids.length) {
            this.unsubscribe();
            return;
        }
        // subscribe_entities speaks HA's compressed diff format, not whole
        // entities: `a` is the initial snapshot, `c` is a per-entity patch under
        // a "+" key, `r` is removals.
        this.subscribe(ids, function(data) {
            var ev = (data && data.event) || {};
            var changed = false;

            if (ev.a) {
                for (var addedId in ev.a) {
                    var added = ev.a[addedId];
                    self.appState.setEntity(addedId, {
                        entity_id: addedId,
                        state: added.s,
                        attributes: added.a || {},
                        last_changed: added.lc,
                    });
                    changed = true;
                }
            }

            if (ev.c) {
                for (var changedId in ev.c) {
                    var plus = ev.c[changedId]['+'] || {};
                    var stateDict = self.appState.ha_state_dict || {};
                    var cur = stateDict[changedId] || { entity_id: changedId, state: '', attributes: {} };
                    self.appState.setEntity(changedId, {
                        entity_id: changedId,
                        state: plus.s !== undefined ? plus.s : cur.state,
                        attributes: plus.a !== undefined ? plus.a : cur.attributes,
                        last_changed: plus.lc !== undefined ? plus.lc : cur.last_changed,
                    });
                    changed = true;
                }
            }

            if (!changed) { return; }

            // If the screen DEFINITIONS changed, rebuild rather than just
            // recolouring. Guarded by a content comparison because the
            // dashboard entity also updates for unrelated reasons, and
            // rebuilding on every tick would fight whoever is scrolling.
            if (self.screensChanged()) {
                self.loadScreens();
                return;
            }

            self.refreshTiles();
        });
    }

    /**
     * @returns {boolean} whether HA is now publishing different screens than
     *   the ones currently on display.
     */
    screensChanged() {
        var dashboardId = this.appState.dashboard_entity || DEFAULT_DASHBOARD_ENTITY;
        var stateDict = this.appState.ha_state_dict || {};
        var entity = stateDict[dashboardId];
        if (!entity || !entity.attributes) { return false; }

        var key = JSON.stringify(entity.attributes.screens);
        if (key === this.screensKey) { return false; }
        this.screensKey = key;
        return true;
    }

    /**
     * Moves the selection, rolling over into the neighbouring screen at either
     * end rather than wrapping within the current one.
     *
     * That rollover is what makes every tile on every screen reachable with the
     * buttons alone. Swiping is faster, but it must never be the ONLY way to
     * reach a screen: touch is unavailable with gloves on, and the emulator
     * cannot inject touch events at all, so a swipe-only pager would be
     * untestable as well as unusable.
     */
    moveSelection(delta) {
        if (!this.tileViews.length) { return; }
        this.disarm();

        var next = this.tileIndex + delta;

        if (next >= this.tileViews.length) {
            if (this.screens.length > 1) {
                return this.changeScreen(1);
            }
            next = 0;
        } else if (next < 0) {
            if (this.screens.length > 1) {
                return this.changeScreen(-1, true);
            }
            next = this.tileViews.length - 1;
        }

        this.tileIndex = next;
        this.refreshTiles();
    }

    /**
     * @param {number} delta - Screens to move by, usually 1 or -1.
     * @param {boolean} [selectLast] - Land on the last tile instead of the
     *   first, so that scrolling backwards off the top of a screen feels
     *   continuous rather than jumping to the far corner.
     */
    changeScreen(delta, selectLast) {
        if (this.screens.length < 2) { return; }
        this.disarm();
        this.screenIndex = (this.screenIndex + delta + this.screens.length) % this.screens.length;
        this.tileIndex = 0;
        this.render();
        if (selectLast && this.tileViews.length) {
            this.tileIndex = this.tileViews.length - 1;
            this.refreshTiles();
        }
        this.subscribeToScreen();
    }

    onTap(e) {
        var wind = this.menu;
        var self = this;
        // Ignore the header strip; only tiles are actionable.
        if (e.position.y < HEADER_H) { return; }

        var hit = wind.elementAt(e.position, function(element) {
            return self.indexOfRect(element) !== -1;
        });
        if (!hit) { return; }

        var index = this.indexOfRect(hit);
        if (index === -1) { return; }

        // A tap both moves the selection and fires, so the highlight always
        // agrees with what just happened.
        this.tileIndex = index;
        this.activate(index);
    }

    indexOfRect(element) {
        for (var i = 0; i < this.tileViews.length; ++i) {
            if (this.tileViews[i].rect === element) { return i; }
        }
        return -1;
    }

    onSwipe(e) {
        switch (e.direction) {
            case 'left':
                return this.changeScreen(1);
            case 'right':
                // Right is "back" everywhere else on this watch, so only page
                // backwards when there is a previous screen to go to.
                if (this.screenIndex > 0) { return this.changeScreen(-1); }
                return this.menu.hide();
            case 'up':
                return this.moveSelection(1);
            case 'down':
                return this.moveSelection(-1);
        }
    }

    disarm() {
        if (this.armedTimer) {
            clearTimeout(this.armedTimer);
            this.armedTimer = null;
        }
        var wasArmed = this.armed !== null;
        this.armed = null;
        if (wasArmed) {
            this.refreshTiles();
        }
    }

    activate(index) {
        var self = this;
        var view = this.tileViews[index];
        if (!view) { return; }
        var tile = view.tile;

        // A value tile is a readout. Firing something because a finger landed
        // on a number would be the worst kind of surprise, so it does nothing
        // unless it was explicitly given an action.
        if (tile.type === 'value' && !tile.action) {
            return;
        }

        if (tile.confirm && this.armed !== index) {
            this.disarm();
            this.armed = index;
            this.armedTimer = setTimeout(function() {
                self.armedTimer = null;
                self.armed = null;
                self.refreshTiles();
            }, CONFIRM_MS);
            Vibe.vibrate('short');
            this.refreshTiles();
            return;
        }

        this.disarm();
        this.fire(tile);
    }

    /**
     * Turns a tile definition into an HA service call.
     *
     * `action` is either an explicit "domain.service" or the word "toggle"
     * (also the default when the tile has an entity). Anything a tile puts in
     * `data` becomes service data, and `target` is passed through so a tile can
     * act on a whole area rather than one entity.
     */
    resolveCall(tile) {
        var action = tile.action || (tile.entity ? 'toggle' : null);
        if (!action) { return null; }

        var target = tile.target || (tile.entity ? { entity_id: tile.entity } : {});
        var data = tile.data || {};

        if (action.indexOf('.') !== -1) {
            var parts = action.split('.');
            return { domain: parts[0], service: parts[1], data: data, target: target };
        }

        if (action !== 'toggle' || !tile.entity) {
            helpers.log_message('Dashboard: tile action "' + action + '" needs an entity or a domain.service');
            return null;
        }

        var domain = tile.entity.split('.')[0];
        var stateDict = this.appState.ha_state_dict || {};
        var entity = stateDict[tile.entity];
        var state = entity ? entity.state : null;

        // A few domains have no toggle service, so pick the right one from the
        // current state instead.
        if (domain === 'lock') {
            return { domain: domain, service: state === 'locked' ? 'unlock' : 'lock', data: data, target: target };
        }
        if (domain === 'scene') {
            return { domain: domain, service: 'turn_on', data: data, target: target };
        }
        if (domain === 'script' || domain === 'button' || domain === 'input_button') {
            return { domain: domain, service: domain === 'script' ? 'turn_on' : 'press', data: data, target: target };
        }
        return { domain: domain, service: 'toggle', data: data, target: target };
    }

    /**
     * Replaces the header text for a few seconds. A failed service call used to
     * be a double buzz and a log line nobody can read on a wrist, which is
     * indistinguishable from "the button does nothing".
     */
    flash(message, isError) {
        var self = this;
        if (!this.headerText) { return; }

        if (this.flashTimer) {
            clearTimeout(this.flashTimer);
            this.flashTimer = null;
        }

        this.headerText.text(message);
        this.headerText.color(isError ? colours.error : colours.headerAccent);

        this.flashTimer = setTimeout(function() {
            self.flashTimer = null;
            if (!self.headerText) { return; }
            var screen = self.currentScreen();
            self.headerText.text(screen ? (screen.title || 'Dashboard') : 'Dashboard');
            self.headerText.color(colours.headerText);
        }, 3000);
    }

    fire(tile) {
        var self = this;

        // Tiles can drive the APP as well as the house. That is what lets the
        // navigation itself be defined in Home Assistant rather than hardcoded
        // here, so a nav screen is just another screen.
        if (tile.action && tile.action.indexOf('app.') === 0) {
            return this.appAction(tile.action.slice(4));
        }

        var call = this.resolveCall(tile);
        if (!call) {
            this.flash('No action for this tile', true);
            Vibe.vibrate('double');
            return;
        }

        helpers.log_message('Dashboard: ' + call.domain + '.' + call.service + ' ' + JSON.stringify(call.target));

        this.appState.haws.callService(
            call.domain,
            call.service,
            call.data,
            call.target,
            function(data) {
                Vibe.vibrate('short');
                self.flash(tile.label || 'Sent', false);
            },
            function(error) {
                helpers.log_message('Dashboard: service call failed: ' + JSON.stringify(error));
                Vibe.vibrate('double');
                // Home Assistant's own message is far more useful than "it
                // failed" - it names the unsupported service or bad entity.
                var reason = (error && (error.message || error.code)) || 'failed';
                self.flash(String(reason).substring(0, 40), true);
            }
        );
    }

    /**
     * App-level tile actions, addressed as "app.<name>" from the HA config.
     */
    appAction(name) {
        switch (name) {
            case 'assist':
                Vibe.vibrate('short');
                return require('app/pages/AssistPage').showAssistMenu();
            case 'menu':
                Vibe.vibrate('short');
                return require('app/pages/MainMenuPage').showMainMenu();
            case 'favorites':
                Vibe.vibrate('short');
                return require('app/pages/FavoritesPage').showFavorites();
            case 'settings':
                Vibe.vibrate('short');
                return require('app/pages/SettingsMenuPage').showSettingsMenu();
            case 'refresh':
                return this.reload();
            default:
                this.flash('Unknown app action: ' + name, true);
                Vibe.vibrate('double');
        }
    }
}

/**
 * Show the dashboard (convenience function, matching the other pages).
 */
function showDashboard() {
    var page = new DashboardPage();
    page.show();
}

module.exports = DashboardPage;
module.exports.showDashboard = showDashboard;
