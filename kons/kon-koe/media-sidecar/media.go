package main

// The conversions. Every ffmpeg run gets:
//   - an explicit demuxer chosen from the file's first bytes (never ffmpeg's own probing, which would
//     accept HLS or concat playlists that read other files), and only the `file` protocol;
//   - its own temporary directory, removed when the request ends, with names the server chose;
//   - the request's deadline (exec.CommandContext) and arguments as a list (no shell, ever).

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Result is what a conversion answers.
type Result struct {
	Bytes      []byte
	Mime       string
	DurationMs int64
	Waveform   []float64
	Sticker    bool
	Animated   bool
	Quality    int
}

// Converter runs ffmpeg and ffprobe.
type Converter struct {
	FFmpeg  string
	FFprobe string
}

// Available is true when both binaries are on PATH (or at the configured paths).
func (c *Converter) Available() bool {
	_, e1 := exec.LookPath(c.FFmpeg)
	_, e2 := exec.LookPath(c.FFprobe)
	return e1 == nil && e2 == nil
}

const (
	WaveformBars     = 64
	StickerSide      = 512
	StickerStaticMax = 100 * 1024
	StickerAnimMax   = 500 * 1024
	// An animated sticker is cut to this length: WhatsApp's are short loops.
	StickerMaxSeconds = 10
)

// Format is what the first bytes of a file say it is.
type Format struct {
	Demuxer string // ffmpeg's -f
	Kind    string // audio, image, video (a container that may hold audio or video)
	Mime    string
}

var errUnknownFormat = &httpError{Status: 415, Message: "unsupported file type"}

// Detect names the demuxer for a file from its magic bytes, or nil.
func Detect(b []byte) *Format {
	has := func(at int, s string) bool { return len(b) >= at+len(s) && string(b[at:at+len(s)]) == s }
	switch {
	case len(b) < 4:
		return nil
	case has(0, "OggS"):
		return &Format{"ogg", "audio", "audio/ogg"}
	case b[0] == 0x1a && b[1] == 0x45 && b[2] == 0xdf && b[3] == 0xa3:
		return &Format{"matroska", "video", "video/webm"}
	case has(4, "ftyp"):
		return &Format{"mov", "video", "video/mp4"}
	case has(0, "RIFF") && has(8, "WAVE"):
		return &Format{"wav", "audio", "audio/wav"}
	case has(0, "RIFF") && has(8, "WEBP"):
		return &Format{"webp_pipe", "image", "image/webp"}
	case has(0, "#!AMR"):
		return &Format{"amr", "audio", "audio/amr"}
	case has(0, "fLaC"):
		return &Format{"flac", "audio", "audio/flac"}
	case len(b) >= 8 && bytes.Equal(b[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		return &Format{"png_pipe", "image", "image/png"}
	case b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff:
		return &Format{"jpeg_pipe", "image", "image/jpeg"}
	case has(0, "GIF8"):
		return &Format{"gif", "image", "image/gif"}
	case b[0] == 0xff && b[1]&0xf6 == 0xf0:
		return &Format{"aac", "audio", "audio/aac"}
	case has(0, "ID3") || (b[0] == 0xff && b[1]&0xe0 == 0xe0):
		return &Format{"mp3", "audio", "audio/mpeg"}
	}
	return nil
}

// WebPInfo reads width, height and the animation flag from a WebP's first chunk.
type WebPInfo struct {
	Width, Height int
	Animated      bool
}

func ParseWebP(b []byte) (WebPInfo, bool) {
	if len(b) < 30 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return WebPInfo{}, false
	}
	u24 := func(at int) int { return int(b[at]) | int(b[at+1])<<8 | int(b[at+2])<<16 }
	switch string(b[12:16]) {
	case "VP8X":
		return WebPInfo{Width: 1 + u24(24), Height: 1 + u24(27), Animated: b[20]&0x02 != 0}, true
	case "VP8 ":
		if b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
			return WebPInfo{}, false
		}
		return WebPInfo{Width: int(binary.LittleEndian.Uint16(b[26:]) & 0x3fff), Height: int(binary.LittleEndian.Uint16(b[28:]) & 0x3fff)}, true
	case "VP8L":
		if b[20] != 0x2f {
			return WebPInfo{}, false
		}
		bits := binary.LittleEndian.Uint32(b[21:])
		return WebPInfo{Width: int(bits&0x3fff) + 1, Height: int((bits>>14)&0x3fff) + 1}, true
	}
	return WebPInfo{}, false
}

// StickerFits applies WhatsApp's rule: 512×512 WebP, ≤100 KB static, ≤500 KB animated.
func StickerFits(b []byte) (WebPInfo, bool) {
	info, ok := ParseWebP(b)
	if !ok || info.Width != StickerSide || info.Height != StickerSide {
		return info, false
	}
	limit := StickerStaticMax
	if info.Animated {
		limit = StickerAnimMax
	}
	return info, len(b) <= limit
}

// Waveform turns 16-bit mono samples into `bars` loudness values 0..1 (RMS per slice, scaled to the loudest).
func Waveform(samples []int16, bars int) []float64 {
	out := make([]float64, bars)
	if len(samples) == 0 || bars <= 0 {
		return out
	}
	peak := 0.0
	for i := range bars {
		from := i * len(samples) / bars
		to := (i + 1) * len(samples) / bars
		if to <= from {
			to = min(from+1, len(samples))
		}
		sum := 0.0
		for _, s := range samples[from:to] {
			v := float64(s) / 32768
			sum += v * v
		}
		out[i] = math.Sqrt(sum / float64(to-from))
		peak = max(peak, out[i])
	}
	for i := range out {
		if peak > 0 {
			out[i] = math.Round(out[i]/peak*100) / 100
		}
	}
	return out
}

// PCMSamples reads little-endian signed 16-bit samples.
func PCMSamples(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[i*2:]))
	}
	return out
}

// work is one request's temporary directory.
type work struct{ dir string }

func newWork() (*work, error) {
	dir, err := os.MkdirTemp("", "koe-media-*")
	if err != nil {
		return nil, err
	}
	return &work{dir: dir}, nil
}

func (w *work) path(name string) string { return filepath.Join(w.dir, name) }
func (w *work) close()                  { _ = os.RemoveAll(w.dir) }

// run executes a binary with explicit arguments under the request's deadline. stderr is kept short.
func run(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=/tmp"}
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return nil, fmt.Errorf("%s: %w: %s", filepath.Base(bin), err, msg)
	}
	return stdout.Bytes(), nil
}

// input writes the request body and returns the ffmpeg arguments that open it.
func (w *work) input(in []byte, f *Format) ([]string, error) {
	if err := os.WriteFile(w.path("in"), in, 0o600); err != nil {
		return nil, err
	}
	return []string{"-protocol_whitelist", "file", "-f", f.Demuxer, "-i", "file:" + w.path("in")}, nil
}

var ffmpegBase = []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}

func (c *Converter) ffmpeg(ctx context.Context, args ...string) error {
	_, err := run(ctx, c.FFmpeg, append(append([]string{}, ffmpegBase...), args...)...)
	return err
}

// analyze decodes the first audio stream to 8 kHz mono PCM: duration and waveform.
func (c *Converter) analyze(ctx context.Context, w *work, input []string) (int64, []float64, error) {
	out := w.path("pcm")
	args := append(append([]string{}, input...), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-t", "1800", "-c:a", "pcm_s16le", "-f", "s16le", "file:"+out)
	if err := c.ffmpeg(ctx, args...); err != nil {
		return 0, nil, err
	}
	pcm, err := os.ReadFile(out)
	if err != nil {
		return 0, nil, err
	}
	samples := PCMSamples(pcm)
	return int64(len(samples)) * 1000 / 8000, Waveform(samples, WaveformBars), nil
}

func (c *Converter) audio(ctx context.Context, in []byte, codec []string, outName, mime string) (*Result, error) {
	f := Detect(in)
	if f == nil || (f.Kind != "audio" && f.Kind != "video") {
		return nil, errUnknownFormat
	}
	w, err := newWork()
	if err != nil {
		return nil, err
	}
	defer w.close()
	input, err := w.input(in, f)
	if err != nil {
		return nil, err
	}
	out := w.path(outName)
	args := append(append([]string{}, input...), "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1")
	args = append(append(args, codec...), "file:"+out)
	if err := c.ffmpeg(ctx, args...); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &httpError{Status: 422, Message: "this audio cannot be converted"}
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return nil, err
	}
	dur, wave, err := c.analyze(ctx, w, input)
	if err != nil {
		dur, wave = 0, nil // the converted file is what matters
	}
	return &Result{Bytes: b, Mime: mime, DurationMs: dur, Waveform: wave}, nil
}

// Voice: any audio → OGG/Opus, mono, 48 kHz: what WhatsApp shows as a voice note.
func (c *Converter) Voice(ctx context.Context, in []byte) (*Result, error) {
	return c.audio(ctx, in, []string{"-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-application", "voip", "-f", "ogg"}, "out.ogg", "audio/ogg")
}

// Playable: OGG/Opus (or any audio) → MP4/AAC, for browsers that do not play OGG, and for Instagram and
// Messenger, which take no OGG.
func (c *Converter) Playable(ctx context.Context, in []byte) (*Result, error) {
	return c.audio(ctx, in, []string{"-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4"}, "out.m4a", "audio/mp4")
}

const stickerFilter = "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000"

// frames counts the video packets of the input (a one-frame GIF is a static sticker).
func (c *Converter) frames(ctx context.Context, w *work, f *Format) int {
	out, err := run(ctx, c.FFprobe, "-v", "error", "-protocol_whitelist", "file", "-f", f.Demuxer, "-select_streams", "v:0",
		"-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", "file:"+w.path("in"))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(strings.Split(string(out), "\n")[0]))
	return n
}

// Sticker: PNG, JPEG, GIF, WebP or MP4 → WebP 512×512 within WhatsApp's limits, lowering quality until it fits.
func (c *Converter) Sticker(ctx context.Context, in []byte) (*Result, error) {
	f := Detect(in)
	if f == nil || (f.Kind != "image" && f.Demuxer != "mov") {
		return nil, &httpError{Status: 415, Message: "a sticker is made from a PNG, JPEG, GIF, WebP or MP4"}
	}
	if info, ok := StickerFits(in); ok {
		return &Result{Bytes: in, Mime: "image/webp", Sticker: true, Animated: info.Animated, Quality: 100}, nil
	}
	if info, ok := ParseWebP(in); ok && info.Animated {
		// ffmpeg's WebP decoder reads one frame: converting would silently drop the animation.
		return nil, &httpError{Status: 422, Message: "an animated WebP must already be 512×512 within 500 KB; send it as a GIF or MP4 to convert it"}
	}
	w, err := newWork()
	if err != nil {
		return nil, err
	}
	defer w.close()
	input, err := w.input(in, f)
	if err != nil {
		return nil, err
	}
	animated := f.Demuxer == "mov" || (f.Demuxer == "gif" && c.frames(ctx, w, f) > 1)
	out := w.path("out.webp")

	try := func(extra ...string) ([]byte, error) {
		args := append(append([]string{}, input...), extra...)
		if err := c.ffmpeg(ctx, append(args, "-an", "-map_metadata", "-1", "-f", "webp", "file:"+out)...); err != nil {
			return nil, err
		}
		return os.ReadFile(out)
	}

	if !animated {
		for _, q := range []int{90, 80, 70, 60, 50, 40, 30, 20, 10, 5} {
			b, err := try("-vf", stickerFilter, "-frames:v", "1", "-c:v", "libwebp", "-lossless", "0", "-compression_level", "6", "-quality", strconv.Itoa(q))
			if err != nil {
				return nil, convertErr(ctx, err)
			}
			if info, ok := StickerFits(b); ok && !info.Animated {
				return &Result{Bytes: b, Mime: "image/webp", Sticker: true, Quality: q}, nil
			}
		}
		return nil, &httpError{Status: 422, Message: "this image does not fit in 100 KB as a 512×512 sticker"}
	}
	for _, fps := range []int{15, 10, 8} {
		for _, q := range []int{75, 60, 45, 30, 20, 10} {
			b, err := try("-t", strconv.Itoa(StickerMaxSeconds), "-vf", "fps="+strconv.Itoa(fps)+","+stickerFilter, "-c:v", "libwebp_anim", "-loop", "0",
				"-lossless", "0", "-compression_level", "4", "-quality", strconv.Itoa(q))
			if err != nil {
				return nil, convertErr(ctx, err)
			}
			if info, ok := StickerFits(b); ok {
				return &Result{Bytes: b, Mime: "image/webp", Sticker: true, Animated: info.Animated, Quality: q}, nil
			}
		}
	}
	return nil, &httpError{Status: 422, Message: "this animation does not fit in 500 KB as a 512×512 sticker; make it shorter"}
}

func convertErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var he *httpError
	if errors.As(err, &he) {
		return he
	}
	return &httpError{Status: 422, Message: "this file cannot be converted"}
}
