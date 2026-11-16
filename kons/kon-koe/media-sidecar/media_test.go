package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const testToken = "test-token-0123456789"

func testServer(t *testing.T, maxBytes int64) *httptest.Server {
	t.Helper()
	cfg := Settings{Token: testToken, MaxBytes: maxBytes, Timeout: 60 * time.Second, Concurrency: 2, FFmpeg: "ffmpeg", FFprobe: "ffprobe"}
	srv := httptest.NewServer(NewServer(cfg, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler())
	t.Cleanup(srv.Close)
	return srv
}

func post(t *testing.T, url, token string, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

// vp8x builds the first bytes of a WebP with a VP8X header.
func vp8x(w, h int, animated bool, size int) []byte {
	b := make([]byte, max(size, 30))
	copy(b[0:], "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
	copy(b[8:], "WEBPVP8X")
	binary.LittleEndian.PutUint32(b[16:], 10)
	if animated {
		b[20] = 0x02
	}
	put24 := func(at, v int) { b[at], b[at+1], b[at+2] = byte(v), byte(v>>8), byte(v>>16) }
	put24(24, w-1)
	put24(27, h-1)
	return b
}

func TestDetect(t *testing.T) {
	cases := map[string][]byte{
		"ogg":       []byte("OggS\x00\x02rest"),
		"matroska":  {0x1a, 0x45, 0xdf, 0xa3, 0, 0},
		"mov":       []byte("\x00\x00\x00\x18ftypmp42"),
		"png_pipe":  {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0},
		"jpeg_pipe": {0xff, 0xd8, 0xff, 0xe0},
		"gif":       []byte("GIF89a.."),
		"webp_pipe": vp8x(512, 512, false, 40),
		"mp3":       []byte("ID3\x04...."),
		"aac":       {0xff, 0xf1, 0x50, 0x80},
		"wav":       []byte("RIFF\x00\x00\x00\x00WAVEfmt "),
	}
	for want, b := range cases {
		if f := Detect(b); f == nil || f.Demuxer != want {
			t.Errorf("%s: got %+v", want, f)
		}
	}
	// Playlists and text are never handed to ffmpeg.
	for _, b := range [][]byte{[]byte("#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd"), []byte("ffconcat version 1.0"), []byte("<html>")} {
		if f := Detect(b); f != nil {
			t.Errorf("%q detected as %+v", b[:8], f)
		}
	}
}

func TestStickerFits(t *testing.T) {
	if _, ok := StickerFits(vp8x(512, 512, false, 50*1024)); !ok {
		t.Error("512×512 static 50 KB should fit")
	}
	if _, ok := StickerFits(vp8x(512, 512, false, 150*1024)); ok {
		t.Error("static over 100 KB should not fit")
	}
	if info, ok := StickerFits(vp8x(512, 512, true, 400*1024)); !ok || !info.Animated {
		t.Error("animated 400 KB should fit")
	}
	if _, ok := StickerFits(vp8x(500, 512, false, 1024)); ok {
		t.Error("wrong size should not fit")
	}
}

func TestWaveform(t *testing.T) {
	samples := make([]int16, 6400)
	for i := range samples {
		if i >= 3200 {
			samples[i] = 16000
		} else {
			samples[i] = 4000
		}
	}
	w := Waveform(samples, 64)
	if len(w) != 64 || w[63] != 1 || w[0] != 0.25 {
		t.Fatalf("waveform: %v", w)
	}
	for _, v := range Waveform(make([]int16, 100), 64) {
		if v != 0 {
			t.Fatal("silence must be zeros")
		}
	}
}

func TestAuthAndLimits(t *testing.T) {
	srv := testServer(t, 1024)
	if res := post(t, srv.URL+"/voice", "", []byte("OggS")); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: %d", res.StatusCode)
	}
	if res := post(t, srv.URL+"/voice", "wrong-token-xxxxxxxx", []byte("OggS")); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong token: %d", res.StatusCode)
	}
	if res := post(t, srv.URL+"/voice", testToken, make([]byte, 4096)); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("too large: %d", res.StatusCode)
	}
	if res := post(t, srv.URL+"/voice", testToken, nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("empty: %d", res.StatusCode)
	}
	if res := post(t, srv.URL+"/voice", testToken, []byte("#EXTM3U\nfile:///etc/passwd")); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("playlist: %d", res.StatusCode)
	}
	if res := post(t, srv.URL+"/sticker", testToken, []byte("%PDF-1.7 ....")); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("pdf sticker: %d", res.StatusCode)
	}
	// An already valid sticker comes back as is, without ffmpeg.
	ok := vp8x(512, 512, false, 900)
	res := post(t, srv.URL+"/sticker", testToken, ok)
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !bytes.Equal(got, ok) || res.Header.Get("X-Animated") != "false" {
		t.Errorf("valid sticker: %d %s", res.StatusCode, res.Header.Get("X-Animated"))
	}
}

// ── With ffmpeg (skipped where it is not installed) ─────────────────────────

func needFFmpeg(t *testing.T) {
	t.Helper()
	if !(&Converter{FFmpeg: "ffmpeg", FFprobe: "ffprobe"}).Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
}

// generate makes a test file with ffmpeg's own sources.
func generate(t *testing.T, name string, args ...string) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("ffmpeg", append(append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...), out)...)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate %s: %v %s", name, err, b)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestVoiceAndPlayable(t *testing.T) {
	needFFmpeg(t)
	srv := testServer(t, 16<<20)
	// A stereo WebM/Opus, as Chrome records it.
	webm := generate(t, "rec.webm", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2", "-c:a", "libopus", "-f", "webm")
	res := post(t, srv.URL+"/voice", testToken, webm)
	ogg, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "audio/ogg" {
		t.Fatalf("voice: %d %s", res.StatusCode, ogg)
	}
	head := bytes.Index(ogg, []byte("OpusHead"))
	if head < 0 || ogg[head+9] != 1 {
		t.Fatal("voice note must be OGG/Opus mono")
	}
	if d, _ := strconv.Atoi(res.Header.Get("X-Duration-Ms")); d < 1900 || d > 2100 {
		t.Errorf("duration %d", d)
	}
	var wave []float64
	if err := json.Unmarshal([]byte(res.Header.Get("X-Waveform")), &wave); err != nil || len(wave) != WaveformBars {
		t.Errorf("waveform %v %v", wave, err)
	}

	res = post(t, srv.URL+"/playable", testToken, ogg)
	m4a, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "audio/mp4" || string(m4a[4:8]) != "ftyp" {
		t.Fatalf("playable: %d", res.StatusCode)
	}
}

func TestStickers(t *testing.T) {
	needFFmpeg(t)
	srv := testServer(t, 16<<20)
	png := generate(t, "pic.png", "-f", "lavfi", "-i", "testsrc=size=800x600:duration=1", "-frames:v", "1", "-f", "image2", "-c:v", "png")
	res := post(t, srv.URL+"/sticker", testToken, png)
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		t.Fatalf("static sticker: %d %s", res.StatusCode, b)
	}
	if info, ok := StickerFits(b); !ok || info.Animated {
		t.Fatalf("static sticker does not fit: %+v %d bytes", info, len(b))
	}

	gif := generate(t, "anim.gif", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-f", "gif")
	res = post(t, srv.URL+"/sticker", testToken, gif)
	b, _ = io.ReadAll(res.Body)
	if res.StatusCode != 200 || res.Header.Get("X-Animated") != "true" {
		t.Fatalf("animated sticker: %d %s", res.StatusCode, b)
	}
	if info, ok := StickerFits(b); !ok || !info.Animated {
		t.Fatalf("animated sticker does not fit: %+v %d bytes", info, len(b))
	}
}

func TestDeadline(t *testing.T) {
	needFFmpeg(t)
	c := &Converter{FFmpeg: "ffmpeg", FFprobe: "ffprobe"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	time.Sleep(2 * time.Millisecond)
	wav := generate(t, "a.wav", "-f", "lavfi", "-i", "sine=duration=1", "-f", "wav")
	if _, err := c.Voice(ctx, wav); err == nil {
		t.Fatal("an expired deadline must stop ffmpeg")
	}
}
