// Command koe-media converts media for kon-koe: voice notes, browser-playable audio and stickers.
//
// It does one job: bytes in, bytes out, through ffmpeg. It has no database, no credentials of any
// channel, and never fetches a URL, so a forged message cannot make it reach anything. The API calls
// it with a shared secret (KOE_MEDIA_TOKEN) and works without it (see koe.media.ts).
//
//	POST /voice     any audio → OGG/Opus mono 48 kHz (a WhatsApp voice note)
//	                headers: X-Duration-Ms, X-Waveform (JSON array of 64 values 0..1)
//	POST /playable  OGG/Opus (or any audio) → MP4/AAC, which every browser plays; same headers
//	POST /sticker   PNG, JPEG, GIF, WebP or MP4 → WebP 512×512, ≤100 KB static or ≤500 KB animated,
//	                lowering the quality until it fits; 422 when it cannot. Headers: X-Animated, X-Quality
//	GET  /healthz   {"ok":true,...}; no secret needed, says nothing private
//
// Why a sidecar: ffmpeg is a large native dependency with a long history of parser bugs. Keeping it in
// its own container, as an unprivileged user, with explicit demuxers (never ffmpeg's guess, so no HLS or
// concat playlists that read other files), a size limit and a deadline, keeps a malicious file away from
// the API's memory and secrets.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "0.1.0"

// Settings come from the environment only.
type Settings struct {
	Addr        string
	Token       string
	MaxBytes    int64
	Timeout     time.Duration
	Concurrency int
	FFmpeg      string
	FFprobe     string
}

func envInt(name string, def int64) int64 {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func loadSettings() (Settings, error) {
	s := Settings{
		Addr:        os.Getenv("KOE_MEDIA_ADDR"),
		Token:       os.Getenv("KOE_MEDIA_TOKEN"),
		MaxBytes:    envInt("KOE_MEDIA_MAX_MB", 64) * 1024 * 1024,
		Timeout:     time.Duration(envInt("KOE_MEDIA_TIMEOUT_S", 120)) * time.Second,
		Concurrency: int(envInt("KOE_MEDIA_CONCURRENCY", int64(max(1, runtime.NumCPU())))),
		FFmpeg:      os.Getenv("KOE_MEDIA_FFMPEG"),
		FFprobe:     os.Getenv("KOE_MEDIA_FFPROBE"),
	}
	if s.Addr == "" {
		s.Addr = ":8090"
	}
	if s.FFmpeg == "" {
		s.FFmpeg = "ffmpeg"
	}
	if s.FFprobe == "" {
		s.FFprobe = "ffprobe"
	}
	if len(s.Token) < 16 {
		return s, errors.New("KOE_MEDIA_TOKEN must be set (at least 16 characters): the API sends it as a bearer token")
	}
	return s, nil
}

// Server holds what every request shares.
type Server struct {
	cfg   Settings
	conv  *Converter
	slots chan struct{}
	log   *slog.Logger
}

func NewServer(cfg Settings, log *slog.Logger) *Server {
	return &Server{
		cfg:   cfg,
		conv:  &Converter{FFmpeg: cfg.FFmpeg, FFprobe: cfg.FFprobe},
		slots: make(chan struct{}, max(1, cfg.Concurrency)),
		log:   log,
	}
}

// httpError is what a handler answers with: a status and a message safe to show.
type httpError struct {
	Status  int
	Message string
}

func (e *httpError) Error() string { return e.Message }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// authorized compares the bearer token in constant time.
func (s *Server) authorized(r *http.Request) bool {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1
}

// convert wraps one conversion: auth, body limit, a slot, the deadline, errors as JSON.
func (s *Server) convert(fn func(ctx context.Context, in []byte) (*Result, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		if r.ContentLength > s.cfg.MaxBytes {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too large", "maxBytes": s.cfg.MaxBytes})
			return
		}
		in, err := readLimited(w, r, s.cfg.MaxBytes)
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "file too large", "maxBytes": s.cfg.MaxBytes})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read the body"})
			return
		}
		if len(in) == 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "empty file"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Timeout)
		defer cancel()
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
		case <-ctx.Done():
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "busy, try again"})
			return
		}
		started := time.Now()
		res, err := fn(ctx, in)
		if err != nil {
			var he *httpError
			switch {
			case errors.As(err, &he):
				writeJSON(w, he.Status, map[string]string{"error": he.Message})
			case errors.Is(ctx.Err(), context.DeadlineExceeded):
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "conversion took too long"})
			default:
				s.log.Warn("conversion failed", "path", r.URL.Path, "err", err)
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "this file cannot be converted"})
			}
			return
		}
		s.log.Info("converted", "path", r.URL.Path, "in", len(in), "out", len(res.Bytes), "ms", time.Since(started).Milliseconds())
		h := w.Header()
		h.Set("Content-Type", res.Mime)
		h.Set("Content-Length", strconv.Itoa(len(res.Bytes)))
		h.Set("Cache-Control", "no-store")
		if res.DurationMs > 0 {
			h.Set("X-Duration-Ms", strconv.FormatInt(res.DurationMs, 10))
		}
		if res.Waveform != nil {
			if b, err := json.Marshal(res.Waveform); err == nil {
				h.Set("X-Waveform", string(b))
			}
		}
		if res.Sticker {
			h.Set("X-Animated", strconv.FormatBool(res.Animated))
			h.Set("X-Quality", strconv.Itoa(res.Quality))
			h.Set("X-Width", "512")
			h.Set("X-Height", "512")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(res.Bytes)
	}
}

func readLimited(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	body := http.MaxBytesReader(w, r.Body, limit)
	defer body.Close()
	return io.ReadAll(body)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /voice", s.convert(s.conv.Voice))
	mux.HandleFunc("POST /playable", s.convert(s.conv.Playable))
	mux.HandleFunc("POST /sticker", s.convert(s.conv.Sticker))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		ok := s.conv.Available()
		status := http.StatusOK
		if !ok {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{"ok": ok, "version": version, "features": []string{"voice", "playable", "sticker"}})
	})
	return mux
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe GET /healthz on KOE_MEDIA_ADDR and exit 0/1 (for Docker's HEALTHCHECK)")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if *healthcheck {
		addr := os.Getenv("KOE_MEDIA_ADDR")
		if addr == "" {
			addr = ":8090"
		}
		if strings.HasPrefix(addr, ":") {
			addr = "127.0.0.1" + addr
		}
		res, err := (&http.Client{Timeout: 4 * time.Second}).Get("http://" + addr + "/healthz")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	cfg, err := loadSettings()
	if err != nil {
		log.Error("cannot start", "err", err)
		os.Exit(2)
	}
	srv := NewServer(cfg, log)
	if !srv.conv.Available() {
		log.Error("ffmpeg/ffprobe not found", "ffmpeg", cfg.FFmpeg, "ffprobe", cfg.FFprobe)
		os.Exit(2)
	}
	httpSrv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       cfg.Timeout,
		WriteTimeout:      cfg.Timeout + 30*time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Info("koe-media listening", "addr", cfg.Addr, "version", version, "maxBytes", cfg.MaxBytes, "concurrency", cfg.Concurrency)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped", "err", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdown)
}
