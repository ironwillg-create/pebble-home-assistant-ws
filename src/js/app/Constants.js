/**
 * Constants - Application constants and configuration values
 */
const Feature = require('platform/feature');

const Constants = {
    // App versioning
    appVersion: '2.7',
    confVersion: '2.2-icc',
    // The fork's own settings page. Upstream's has no fields for
    // dashboard_entity or the speech settings, and the app can point at only
    // one config URL, so this is a copy of upstream's with those added.
    // Regenerate with data/build_config_page.py, publish on the fork's
    // github-pages branch.
    configPageUrl: 'https://ironwillg-create.github.io/pebble-home-assistant-ws/config/v2.2-icc.html',

    // Debug settings
    debugMode: true,
    debugHAWS: false,

    // Default domains to ignore
    DEFAULT_IGNORE_DOMAINS: [
        'assist_satellite',
        'conversation',
        'tts',
        'stt',
        'wake_word',
        'tag',
        'todo',
        'update',
        'zone'
    ],

    // Feature flags
    enableIcons: true,
    coalesce_messages_enabled: true,
    startup_cache_enabled: true,

    // Colors
    colour: {
        highlight: Feature.color("#00AAFF", "#000000"),
        highlight_text: Feature.color("black", "white")
    },

    // Cache keys for localStorage
    CACHE_KEYS: {
        STATES: 'ha_startup_cache_states',
        AREAS: 'ha_startup_cache_areas',
        FLOORS: 'ha_startup_cache_floors',
        DEVICES: 'ha_startup_cache_devices',
        ENTITIES: 'ha_startup_cache_entities',
        LABELS: 'ha_startup_cache_labels',
        PIPELINES: 'ha_startup_cache_pipelines',
        TIMESTAMP: 'ha_startup_cache_timestamp'
    },

    // Default main menu order
    // Kept in step with DEFAULT_MAIN_MENU_ORDER in pages/MainMenuPage.js.
    DEFAULT_MAIN_MENU_ORDER: [
        'dashboard',
        'assistant',
        'favorites',
        'settings'
    ]
};

module.exports = Constants;
