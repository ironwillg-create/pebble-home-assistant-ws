#include "simply_audio.h"

#ifdef SIMPLY_HAS_AUDIO

#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

// 4-bit IMA ADPCM streamed from the phone and played through the watch
// speaker. Ported from the Craft Agents watchapp (src/c/main.c, v10-v14),
// where this chain is hardware-proven; the comments below record why each
// piece is shaped the way it is, because most of it exists to survive a
// specific failure that was hit for real.
//
// The encoder is _adpcm_encode() in voice-dispatch/watch_audio.py. The tables
// and nibble maths here must stay byte-identical to it or the watch plays
// noise.

#define AUDIO_RING 65536         /* streaming window, malloc'd only while speaking */
#define AUDIO_RING_MIN 16384     /* smallest ring worth trying if the heap is tight */
#define AUDIO_ACK_BYTES 8192     /* tell the phone it may send this much more */
#define MAX_AUDIO_BYTES 480000   /* 60 s at 16 kHz - a sanity check, not a buffer */
#define AUDIO_VOLUME 100         /* 0-100; this speaker needs all of it */

#define STAGE_SAMPLES 1024       /* decoded PCM staged between speaker writes */
#define DRAIN_MS 60

// Two watchdogs, because the two failure modes look different:
//   * the speaker accepts nothing while sitting Idle -> it wedged
//   * the speaker claims to be playing but never drains -> only a clock can
//     tell, so bound playback by the clip's known duration
// Without these, a caller waits on "speaking" forever. The emery emulator hits
// the second case, having no real audio device.
#define DRAIN_STALL_TICKS (5000 / DRAIN_MS)
#define PLAY_SLACK_MS 15000

// speaker_stream_close() plays out what is still buffered before it releases
// the device, and there is no callback for "released". Back-to-back clips
// therefore meet a speaker that is still draining. Poll briefly rather than
// failing outright. TIME-boxed, not attempt-counted: start_playback() is
// re-entered on every arriving chunk, so an attempt counter would be spent by
// the download rather than by the clock.
#define OPEN_RETRY_MS 150
#define OPEN_WAIT_MS 2500

typedef enum AudioState {
  AudioIdle = 0,
  AudioBuffering,
  AudioPlaying,
} AudioState;

// Mirrors AudioStateType in src/js/ui/simply-pebble.js.
typedef enum AudioEvent {
  AudioEventDone = 0,
  AudioEventPlaying,
  AudioEventError,
} AudioEvent;

typedef enum AudioError {
  AudioErrorNone = 0,
  AudioErrorMemory,
  AudioErrorMuted,
  AudioErrorBusy,
  AudioErrorStalled,
  AudioErrorOverrun,
  AudioErrorBadLength,
} AudioError;

typedef struct AudioBeginPacket AudioBeginPacket;

struct __attribute__((__packed__)) AudioBeginPacket {
  Packet packet;
  uint32_t total;
  uint16_t khz;
};

typedef struct AudioDataPacket AudioDataPacket;

struct __attribute__((__packed__)) AudioDataPacket {
  Packet packet;
  uint16_t length;
  uint8_t data[];
};

typedef Packet AudioStopPacket;

typedef struct AudioAckPacket AudioAckPacket;

struct __attribute__((__packed__)) AudioAckPacket {
  Packet packet;
  uint32_t consumed;
};

typedef struct AudioStatePacket AudioStatePacket;

struct __attribute__((__packed__)) AudioStatePacket {
  Packet packet;
  uint8_t state;
  uint8_t error;
};

static SimplyAudio *s_audio_self = NULL;

static AudioState s_state = AudioIdle;
static uint8_t *s_ring = NULL;
static int s_cap = 0;         // ring size = min(clip size, AUDIO_RING)
static int s_total = 0;       // bytes the phone says it will send
static int s_got = 0;         // bytes received so far (cumulative)
static int s_read = 0;        // bytes handed to the decoder so far (cumulative)
static int s_acked = 0;       // s_read last reported to the phone
static uint32_t s_t0 = 0;     // ms at first chunk, for the prebuffer estimate

// Tier in flight. The phone echoes back the rate the SERVER actually encoded
// rather than the watch assuming its request was honoured; a mismatch plays
// back at the wrong rate, which sounds like a chipmunk rather than an error.
static int s_khz = 16;
static int s_bps = 8000;      // wire bytes per second of speech at that tier

static int s_adpcm_pred = 0;
static int s_adpcm_index = 0;

static int16_t s_stage[STAGE_SAMPLES];
static int s_stage_len = 0;
static int s_stage_pos = 0;

static AppTimer *s_drain_timer = NULL;
static AppTimer *s_open_timer = NULL;
static uint32_t s_open_since = 0;
static int s_drain_idle_ticks = 0;
static uint32_t s_play_t0 = 0;

static const int8_t ADPCM_INDEX[16] = {
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8
};

static const int16_t ADPCM_STEP[89] = {
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
};

static void audio_start_playback(void);
static void audio_stop(AudioError error);

// Pebble's time_ms() only hands back the milliseconds within the current
// second, so pair it with the seconds clock for something that can be
// subtracted across a multi-second download.
//
// Do NOT try to take the seconds from time_ms()'s out-param: passing it a
// time_t* while out_ms is NULL leaves the value untouched, so this wraps once
// a second and any rate estimate built on it is garbage.
static uint32_t now_ms(void) {
  return (uint32_t) time(NULL) * 1000u + (uint32_t) time_ms(NULL, NULL);
}

static bool send_state(AudioEvent event, AudioError error) {
  AudioStatePacket packet = {
    .packet.type = CommandAudioState,
    .packet.length = sizeof(packet),
    .state = event,
    .error = error,
  };
  return simply_msg_send_packet(&packet.packet);
}

// Credit-based flow control. The phone may run at most one ring ahead of what
// the watch has confirmed it consumed; without this, a link faster than
// playback wraps the ring onto audio that has not been heard yet. Cheap to
// send, and it is what lets the ring be smaller than a whole clip at all.
static void grant_credit(bool force) {
  if (s_state == AudioIdle) return;
  if (!force && s_read - s_acked < AUDIO_ACK_BYTES) return;
  if (s_read == s_acked) return;
  s_acked = s_read;

  AudioAckPacket packet = {
    .packet.type = CommandAudioAck,
    .packet.length = sizeof(packet),
    .consumed = (uint32_t) s_acked,
  };
  simply_msg_send_packet(&packet.packet);
}

static int16_t adpcm_decode_nibble(uint8_t code) {
  int step = ADPCM_STEP[s_adpcm_index];
  int delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;

  if (code & 8) s_adpcm_pred -= delta;
  else s_adpcm_pred += delta;
  if (s_adpcm_pred > 32767) s_adpcm_pred = 32767;
  if (s_adpcm_pred < -32768) s_adpcm_pred = -32768;

  s_adpcm_index += ADPCM_INDEX[code];
  if (s_adpcm_index < 0) s_adpcm_index = 0;
  if (s_adpcm_index > 88) s_adpcm_index = 88;

  return (int16_t) s_adpcm_pred;
}

// Refill the PCM staging buffer from whatever ADPCM has arrived. Returns false
// when there is nothing decodable right now (ring drained or clip finished).
static bool stage_refill(void) {
  int avail = s_got - s_read;
  if (avail <= 0 || s_cap <= 0) return false;

  int take = avail;
  if (take > STAGE_SAMPLES / 2) take = STAGE_SAMPLES / 2;  // 2 samples per byte

  // Stop at the end of the ring; the next call picks up from the start again.
  int rpos = s_read % s_cap;
  if (take > s_cap - rpos) take = s_cap - rpos;
  if (take <= 0) return false;

  int n = 0;
  for (int i = 0; i < take; i++) {
    uint8_t b = s_ring[rpos + i];
    s_stage[n++] = adpcm_decode_nibble(b & 0x0F);
    s_stage[n++] = adpcm_decode_nibble((b >> 4) & 0x0F);
  }
  s_read += take;
  s_stage_len = n;
  s_stage_pos = 0;
  return n > 0;
}

static void audio_finish(void) {
  speaker_stream_close();          // plays out whatever the speaker still holds
  if (s_ring) { free(s_ring); s_ring = NULL; }
  s_state = AudioIdle;
  send_state(AudioEventDone, AudioErrorNone);
}

// Keep the speaker's buffer topped up. Runs every DRAIN_MS while playing.
static void audio_drain_cb(void *ctx) {
  s_drain_timer = NULL;
  if (s_state != AudioPlaying || !s_ring) return;

  // Several passes per tick so playback stays ahead of the timer even when the
  // speaker accepts data in small bites.
  uint32_t moved = 0;
  for (int pass = 0; pass < 8; pass++) {
    if (s_stage_pos >= s_stage_len && !stage_refill()) break;

    uint32_t want = (uint32_t) ((s_stage_len - s_stage_pos) * 2);
    uint32_t wrote = speaker_stream_write(&s_stage[s_stage_pos], want);
    s_stage_pos += (int) (wrote / 2);
    moved += wrote;
    if (wrote < want) break;       // speaker buffer full; try again next tick
  }

  grant_credit(false);

  bool drained = (s_stage_pos >= s_stage_len) && (s_read >= s_got);
  if (drained && s_got >= s_total) {
    audio_finish();
    return;
  }

  // Nothing moved and nothing left to decode means we are waiting on the link,
  // which is fine. Nothing moved while data IS queued and the speaker reports
  // Idle means it has wedged. The status check matters because a speaker that
  // is busy playing legitimately refuses writes, and that must not be mistaken
  // for a stall.
  bool queued = (s_stage_pos < s_stage_len) || (s_read < s_got);
  if (moved == 0 && queued && speaker_get_status() == SpeakerStatusIdle) {
    if (++s_drain_idle_ticks > DRAIN_STALL_TICKS) {
      APP_LOG(APP_LOG_LEVEL_ERROR, "audio: speaker stalled at %d/%d", s_read, s_total);
      audio_stop(AudioErrorStalled);
      return;
    }
  } else if (moved > 0) {
    s_drain_idle_ticks = 0;
  }

  // Hard ceiling: a clip is total/bps seconds long, so anything much past that
  // is not playing no matter what the speaker reports.
  uint32_t budget = (uint32_t) ((int64_t) s_total * 1000 / s_bps) + PLAY_SLACK_MS;
  if (now_ms() - s_play_t0 > budget) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "audio: overran %ums at %d/%d",
            (unsigned) budget, s_read, s_total);
    audio_stop(AudioErrorStalled);
    return;
  }

  s_drain_timer = app_timer_register(DRAIN_MS, audio_drain_cb, NULL);
}

static void audio_open_retry_cb(void *ctx) {
  s_open_timer = NULL;
  audio_start_playback();
}

static void audio_start_playback(void) {
  if (s_state == AudioPlaying) return;

  SpeakerPcmFormat fmt = (s_khz == 16) ? SpeakerPcmFormat_16kHz_16bit
                                       : SpeakerPcmFormat_8kHz_16bit;
  if (!speaker_stream_open(fmt, AUDIO_VOLUME)) {
    if (!s_open_since) s_open_since = now_ms();
    if (now_ms() - s_open_since < OPEN_WAIT_MS) {
      if (!s_open_timer) {
        s_open_timer = app_timer_register(OPEN_RETRY_MS, audio_open_retry_cb, NULL);
      }
      return;                    // stay in Buffering; the timer drives us
    }
    audio_stop(AudioErrorBusy);
    return;
  }

  s_open_since = 0;
  s_state = AudioPlaying;
  s_drain_idle_ticks = 0;
  s_play_t0 = now_ms();
  APP_LOG(APP_LOG_LEVEL_INFO, "audio: play %dkHz at %d/%d bytes", s_khz, s_got, s_total);
  send_state(AudioEventPlaying, AudioErrorNone);

  if (s_drain_timer) app_timer_cancel(s_drain_timer);
  s_drain_timer = app_timer_register(1, audio_drain_cb, NULL);
}

// Decide whether enough is banked to start without running dry mid-sentence.
//
// Playback eats s_bps bytes/s. If the link delivers slower than that, starting
// early guarantees a stall, so wait until what we hold will outlast the rest of
// the download (with a margin). If the link is fast this clears almost
// immediately.
static void audio_maybe_start(void) {
  if (s_state != AudioBuffering) return;

  if (s_got >= s_total) { audio_start_playback(); return; }

  // The ring is full: there is nowhere left to bank, so waiting cannot help.
  if (s_got - s_read >= s_cap) { audio_start_playback(); return; }

  uint32_t elapsed = now_ms() - s_t0;
  if (elapsed < 600) return;                       // too early to judge rate

  int64_t rate = ((int64_t) s_got * 1000) / (int64_t) elapsed;
  if (rate <= 0) return;

  int64_t remaining = (int64_t) s_total - s_got;
  int64_t fetch_ms = (remaining * 1000) / rate;
  // What we hold plays for this long; require it to outlast the fetch by ~15%.
  int64_t hold_ms = ((int64_t) (s_got - s_read) * 1000) / s_bps;
  if (hold_ms >= fetch_ms + fetch_ms / 6) {
    audio_start_playback();
  }
}

static void audio_reset_state(void) {
  if (s_drain_timer) { app_timer_cancel(s_drain_timer); s_drain_timer = NULL; }
  if (s_open_timer) { app_timer_cancel(s_open_timer); s_open_timer = NULL; }
  s_open_since = 0;
  if (s_ring) { free(s_ring); s_ring = NULL; }
  s_state = AudioIdle;
  s_cap = s_total = s_got = s_read = s_acked = 0;
  s_stage_len = s_stage_pos = 0;
  s_adpcm_pred = s_adpcm_index = 0;
  s_drain_idle_ticks = 0;
}

static void audio_stop(AudioError error) {
  bool was_active = (s_state != AudioIdle);
  if (was_active) {
    speaker_stop();
    speaker_stream_close();
  }
  audio_reset_state();
  send_state(error == AudioErrorNone ? AudioEventDone : AudioEventError, error);
}

static void handle_begin_packet(Simply *simply, Packet *data) {
  AudioBeginPacket *packet = (AudioBeginPacket*) data;

  // Any previous clip is abandoned rather than queued: the caller asked for
  // this one now.
  if (s_state != AudioIdle) {
    speaker_stop();
    speaker_stream_close();
  }
  audio_reset_state();

  if (speaker_is_muted()) {
    send_state(AudioEventError, AudioErrorMuted);
    return;
  }

  int total = (int) packet->total;
  if (total <= 0 || total > MAX_AUDIO_BYTES) {
    send_state(AudioEventError, AudioErrorBadLength);
    return;
  }

  s_total = total;
  s_khz = (packet->khz == 8) ? 8 : 16;
  s_bps = (s_khz == 16) ? 8000 : 4000;

  // Ring is min(clip, AUDIO_RING) so a short clip does not reserve 64 KB. If
  // the heap cannot spare that much, step down rather than refusing to speak:
  // a smaller window just means the phone is throttled harder.
  int want = (total < AUDIO_RING) ? total : AUDIO_RING;
  while (want >= AUDIO_RING_MIN || want == total) {
    s_ring = malloc(want);
    if (s_ring) break;
    if (want == total && total < AUDIO_RING_MIN) break;  // tiny clip, no room
    want /= 2;
    if (want < AUDIO_RING_MIN) break;
  }
  if (!s_ring) {
    send_state(AudioEventError, AudioErrorMemory);
    return;
  }

  s_cap = want;
  s_state = AudioBuffering;
  s_t0 = now_ms();

  // Prime the phone with a full ring of credit.
  AudioAckPacket ack = {
    .packet.type = CommandAudioAck,
    .packet.length = sizeof(ack),
    .consumed = 0,
  };
  simply_msg_send_packet(&ack.packet);
}

static void handle_data_packet(Simply *simply, Packet *data) {
  AudioDataPacket *packet = (AudioDataPacket*) data;
  if (s_state == AudioIdle || !s_ring) return;

  int len = (int) packet->length;
  if (len <= 0) return;

  // A chunk bigger than the ring cannot be stored at all. This is a hard error
  // rather than a truncation, because truncating desynchronises the decoder
  // and every later sample is noise.
  if (len > s_cap) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "audio: chunk %d exceeds ring %d", len, s_cap);
    audio_stop(AudioErrorOverrun);
    return;
  }

  // Refuse to wrap onto audio that has not been decoded yet. Credit should
  // already prevent this; if it happens, the phone ignored the window and
  // playing on would emit noise.
  if (s_got + len - s_read > s_cap) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "audio: overrun, %d unread of %d", s_got - s_read, s_cap);
    audio_stop(AudioErrorOverrun);
    return;
  }

  int wpos = s_got % s_cap;
  int first = s_cap - wpos;
  if (first > len) first = len;
  memcpy(s_ring + wpos, packet->data, first);
  if (len > first) {
    memcpy(s_ring, packet->data + first, len - first);
  }
  s_got += len;

  audio_maybe_start();
}

bool simply_audio_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandAudioBegin:
      handle_begin_packet(simply, packet);
      return true;
    case CommandAudioData:
      handle_data_packet(simply, packet);
      return true;
    case CommandAudioStop:
      audio_stop(AudioErrorNone);
      return true;
    default:
      break;
  }
  return false;
}

SimplyAudio *simply_audio_create(Simply *simply) {
  if (s_audio_self) {
    return s_audio_self;
  }

  SimplyAudio *self = malloc(sizeof(*self));
  if (!self) {
    return NULL;
  }
  *self = (SimplyAudio) {
    .simply = simply,
  };
  s_audio_self = self;

  return self;
}

void simply_audio_destroy(SimplyAudio *self) {
  if (!self) {
    return;
  }

  if (s_state != AudioIdle) {
    speaker_stop();
    speaker_stream_close();
  }
  audio_reset_state();

  free(self);

  s_audio_self = NULL;
}

#endif  // SIMPLY_HAS_AUDIO
