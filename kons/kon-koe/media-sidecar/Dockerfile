# koe media sidecar: a Go server around ffmpeg, as an unprivileged user.
#
#   docker build -t kitsuden/koe-media kons/kon-koe/media-sidecar
#   docker run --rm -e KOE_MEDIA_TOKEN=<long random secret> -p 127.0.0.1:8090:8090 kitsuden/koe-media
#
# The API reaches it with KOE_MEDIA_URL=http://<host>:8090 and the same KOE_MEDIA_TOKEN.
# Tests (ffmpeg included): docker build --target test kons/kon-koe/media-sidecar
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/koe-media .

# `--target test`: the unit tests and the ffmpeg conversions, with the same ffmpeg as the runtime image.
FROM golang:1.25-alpine AS test
RUN apk add --no-cache ffmpeg
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go vet ./... && go test -count=1 ./...

FROM alpine:3.22
# ffmpeg from Alpine carries libopus (voice notes), aac (playable copies) and libwebp (stickers).
RUN apk add --no-cache ffmpeg ca-certificates \
 && addgroup -S -g 10001 koe && adduser -S -D -H -u 10001 -G koe koe
COPY --from=build /out/koe-media /usr/local/bin/koe-media
USER 10001:10001
ENV KOE_MEDIA_ADDR=:8090 TMPDIR=/tmp
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/local/bin/koe-media", "-healthcheck"]
ENTRYPOINT ["/usr/local/bin/koe-media"]
