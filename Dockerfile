# Debian 13 (trixie): its packages give PrusaSlicer 2.9.2, OpenSCAD 2021.01 and Node 20
# with the libraries they need resolved by apt.
FROM debian:trixie-slim

# --no-install-recommends keeps out desktop extras. PrusaSlicer still pulls its GUI
# libraries (it's one binary for GUI and command line), which is most of the image size.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nodejs prusa-slicer openscad \
      fonts-dejavu-core fonts-dejavu-extra fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user, uid 1000, to match the README's `chown 1000:1000 data`.
# HOME=/tmp gives PrusaSlicer and OpenSCAD somewhere writable for their config dirs.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin calbench
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production HOME=/tmp

WORKDIR /app
COPY server.js slicer.js selftest.js seed.json ./
COPY models ./models
COPY public ./public

# Fail the build now, with a reason, rather than at the first slice.
USER calbench
RUN node selftest.js

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
