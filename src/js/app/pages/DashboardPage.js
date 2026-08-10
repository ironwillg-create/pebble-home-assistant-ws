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

var HEADER_H = 22;
var GAP = 3;

// How long an armed confirm tile stays armed before it forgets. Long enough to
// press twice deliberately, short enough that a pocket press later does nothing.
var CONFIRM_MS = 4000;

var colours = {
  bg: 'black',
  header: Constants.colour.highlight,
  headerText: Constants.colour.highlight_text,
  tile: Feature.color('#555555', 'black'),
  tileOn: Feature.color('#00AA00', 'white'),
  tileUnavailable: Feature.color('#AA0000', 'black'),
  tileArmed: Feature.color('#FFAA00', 'white'),
  text: Feature.color('white', 'white'),
  textOn: Feature.color('white', 'black'),
  select: Feature.color('#00AAFF', 'white'),
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

        // Header: screen title on the left, page position on the right so it is
        // obvious there are more screens to swipe to.
        var heading = screen.title || 'Dashboard';
        if (this.screens.length > 1) {
            heading += '  ' + (this.screenIndex + 1) + '/' + this.screens.length;
        }
        var headerBg = new UI.Rect({
            position: new Vector2(0, 0),
            size: new Vector2(size.x, HEADER_H),
            backgroundColor: colours.header,
        });
        wind.add(headerBg);
        this.headerText = new UI.Text({
            position: new Vector2(4, 1),
            size: new Vector2(size.x - 8, HEADER_H),
            text: heading,
            font: 'gothic-18-bold',
            color: colours.headerText,
            textAlign: 'left',
        });
        wind.add(this.headerText);

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
                borderWidth: 2,
            });
            wind.add(rect);

            var label = new UI.Text({
                position: new Vector2(x + 3, y + 2),
                size: new Vector2(tileW - 6, tileH - 4),
                text: tiles[i].label || tiles[i].entity || '?',
                font: 'gothic-18-bold',
                color: colours.text,
                textAlign: 'center',
            });
            wind.add(label);

            var stateText = new UI.Text({
                position: new Vector2(x + 3, y + tileH - 20),
                size: new Vector2(tileW - 6, 18),
                text: '',
                font: 'gothic-14',
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
                stateLabel = state;
                if (isUnavailable(state)) {
                    background = colours.tileUnavailable;
                } else if (isOn(state)) {
                    background = colours.tileOn;
                    textColour = colours.textOn;
                }
            }

            if (this.armed === i) {
                background = colours.tileArmed;
                textColour = colours.textOn;
                stateLabel = 'confirm?';
            }

            view.rect.backgroundColor(background);
            view.rect.borderColor(i === this.tileIndex ? colours.select : 'clear');
            view.label.color(textColour);
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

            if (changed) {
                self.refreshTiles();
            }
        });
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

    fire(tile) {
        var call = this.resolveCall(tile);
        if (!call) {
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
            },
            function(error) {
                helpers.log_message('Dashboard: service call failed: ' + JSON.stringify(error));
                Vibe.vibrate('double');
            }
        );
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
