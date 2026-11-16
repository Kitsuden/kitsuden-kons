# kon-dc gateway worker: a static Go binary on an empty image.
#
#   docker build -t kitsuden/dc-gateway kons/kon-dc/gateway
#
# Result: one ~6 MB binary + CA certificates, running as an unprivileged user, no shell.
FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/dc-gateway .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/dc-gateway /dc-gateway
USER 65534:65534
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/dc-gateway", "-healthcheck"]
ENTRYPOINT ["/dc-gateway"]
