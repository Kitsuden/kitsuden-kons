# koe media sidecar

A small Go server around ffmpeg that converts media for kon-koe. It is optional: koe works
without it, with the limits listed below.

| Endpoint | In | Out |
| --- | --- | --- |
| `POST /voice` | any audio (WebM/Opus from Chrome and Firefox, MP4/AAC from Safari, OGG, MP3, AAC, AMR, WAV, FLAC) | OGG/Opus, mono, 48 kHz: what WhatsApp shows as a voice note. Headers `X-Duration-Ms`, `X-Waveform` (JSON, 64 values 0..1) |
| `POST /playable` | OGG/Opus (or any audio above) | MP4/AAC (`audio/mp4`), same headers |
| `POST /sticker` | PNG, JPEG, GIF, WebP, MP4 | WebP 512×512, ≤100 KB static or ≤500 KB animated (≤10 s), lowering quality until it fits; 422 when it cannot. Headers `X-Animated`, `X-Quality` |
| `GET /healthz` | | `{"ok":true,"features":[...]}` |

The body is the file itself (not multipart). Every `POST` needs `Authorization: Bearer <KOE_MEDIA_TOKEN>`.
Errors are JSON `{"error": "..."}`: 401, 413 (too large), 415 (not a supported type), 422 (cannot be
converted), 503 (busy), 504 (took too long).

## Run it

```bash
docker build -t kitsuden/koe-media kons/kon-koe/media-sidecar
docker run --rm -e KOE_MEDIA_TOKEN=<long random secret> -p 127.0.0.1:8090:8090 kitsuden/koe-media
```

Then, in the API's environment: `KOE_MEDIA_URL=http://<host>:8090` and the same `KOE_MEDIA_TOKEN`.
Keep the port on a private network; it has no rate limit of its own.

| Variable | Default | |
| --- | --- | --- |
| `KOE_MEDIA_TOKEN` | (required, ≥16 characters) | shared secret with the API |
| `KOE_MEDIA_ADDR` | `:8090` | listen address |
| `KOE_MEDIA_MAX_MB` | `64` | largest request body |
| `KOE_MEDIA_TIMEOUT_S` | `120` | deadline of one conversion (ffmpeg is killed after it) |
| `KOE_MEDIA_CONCURRENCY` | number of CPUs | conversions at a time; the rest wait (503 if the deadline passes) |

## How it stays safe

- It never fetches a URL and holds no channel credentials: bytes in, bytes out.
- ffmpeg gets an explicit demuxer chosen from the file's first bytes, and only the `file` protocol, so
  an HLS or concat playlist disguised as audio cannot make it read other files.
- ffmpeg runs through `exec.CommandContext` with an argument list (no shell), in a temporary directory
  per request that is removed at the end, under the request's deadline.
- The image runs as an unprivileged user (uid 10001).

## What koe does with it

- Agent records a voice note: `/voice` gives the OGG/Opus file WhatsApp needs (the media's main file),
  and `/playable` an MP4/AAC copy (`playable_key`). **Instagram and Messenger take no OGG**: a voice note
  goes to them as that MP4/AAC copy (`channelFileOf()` in `koe.media.ts`). Without the sidecar there is no
  copy, so a voice note cannot be sent to Instagram or Messenger.
- A received WhatsApp voice note: `/playable` gives the inbox a copy every browser plays, its duration
  and a waveform.
- A sticker that is not already a valid WhatsApp sticker: `/sticker`.

Without the sidecar: a recording that is not already OGG/Opus mono is kept as a plain `audio` file (the
upload's answer says why), inbound voice notes have no playable copy or waveform, and stickers that do
not already fit are refused with 422.

## Not done here

- Transcription. koe calls `POST /transcribe` (answering `{"text": "..."}`) only when the API has
  `KOE_MEDIA_TRANSCRIBE=true`; this sidecar does not implement it.
- Animated WebP input that does not already fit: ffmpeg's WebP decoder reads one frame, so it is refused
  (422) instead of silently losing the animation. Send the animation as GIF or MP4.

## Tests

```bash
docker build --target test kons/kon-koe/media-sidecar
```

runs `go vet` and `go test` with Alpine's ffmpeg. Without ffmpeg on PATH, `go test` runs only the tests
that do not need it.
