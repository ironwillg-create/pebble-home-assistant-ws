#include "simply_touch.h"

#ifdef SIMPLY_HAS_TOUCH

#include "simply_msg.h"

#include "simply.h"

#include <pebble.h>

typedef struct TouchConfigPacket TouchConfigPacket;

struct __attribute__((__packed__)) TouchConfigPacket {
  Packet packet;
  bool subscribed;
  bool wants_moves;
};

typedef struct TouchDataPacket TouchDataPacket;

struct __attribute__((__packed__)) TouchDataPacket {
  Packet packet;
  TouchEventType type:8;
  int16_t x;
  int16_t y;
};

static SimplyTouch *s_touch = NULL;

static bool send_touch_data(const TouchEvent *event) {
  TouchDataPacket packet = {
    .packet.type = CommandTouchData,
    .packet.length = sizeof(packet),
    .type = event->type,
    .x = event->x,
    .y = event->y,
  };
  return simply_msg_send_packet(&packet.packet);
}

static void handle_touch(const TouchEvent *event, void *context) {
  if (!s_touch) {
    return;
  }
  if (event->type == TouchEvent_PositionUpdate && !s_touch->wants_moves) {
    return;
  }
  // A dropped touch packet is not worth retrying: by the time a retry landed
  // the gesture would already have been resolved by a later event, and a stale
  // touchdown would make the JS state machine invent a swipe that never
  // happened. Losing the event is the safe failure.
  send_touch_data(event);
}

static void set_subscribe(SimplyTouch *self, bool subscribe) {
  if (self->subscribed == subscribe) {
    return;
  }
  if (subscribe) {
    touch_service_subscribe(handle_touch, NULL);
  } else {
    touch_service_unsubscribe();
  }
  self->subscribed = subscribe;
}

static void handle_touch_config_packet(Simply *simply, Packet *data) {
  TouchConfigPacket *packet = (TouchConfigPacket*) data;
  if (!simply->touch) {
    return;
  }
  simply->touch->wants_moves = packet->wants_moves;
  set_subscribe(simply->touch, packet->subscribed);
}

bool simply_touch_handle_packet(Simply *simply, Packet *packet) {
  switch (packet->type) {
    case CommandTouchConfig:
      handle_touch_config_packet(simply, packet);
      return true;
    default:
      break;
  }
  return false;
}

SimplyTouch *simply_touch_create(Simply *simply) {
  if (s_touch) {
    return s_touch;
  }

  SimplyTouch *self = malloc(sizeof(*self));
  if (!self) {
    return NULL;
  }
  *self = (SimplyTouch) {
    .simply = simply,
    .subscribed = false,
    .wants_moves = false,
  };
  s_touch = self;

  // Deliberately not subscribed here. The JS side turns the sensor on when a
  // window that wants touch is shown, and off again when it goes away.

  return self;
}

void simply_touch_destroy(SimplyTouch *self) {
  if (!self) {
    return;
  }

  set_subscribe(self, false);

  free(self);

  s_touch = NULL;
}

#endif  // SIMPLY_HAS_TOUCH
