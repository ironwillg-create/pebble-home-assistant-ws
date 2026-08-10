#pragma once

#include "simply_msg.h"
#include "simply.h"

#include <pebble.h>

// The speaker exists on the same platforms as the digitizer: Pebble Time 2 and
// later. Everything else compiles the subsystem away.
#if defined(PBL_PLATFORM_EMERY) || defined(PBL_PLATFORM_FLINT) || \
    defined(PBL_PLATFORM_GABBRO)
#define SIMPLY_HAS_AUDIO 1
#endif

typedef struct SimplyAudio SimplyAudio;

struct SimplyAudio {
  Simply *simply;
};

#ifdef SIMPLY_HAS_AUDIO

SimplyAudio *simply_audio_create(Simply *simply);
void simply_audio_destroy(SimplyAudio *self);

bool simply_audio_handle_packet(Simply *simply, Packet *packet);

#else

#define simply_audio_create(simply) NULL
#define simply_audio_destroy(self)

#define simply_audio_handle_packet(simply, packet) (false)

#endif
