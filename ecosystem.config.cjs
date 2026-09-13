/**
 * PM2: run from the backend repo root so `.env` + `dist/` resolve correctly.
 *
 *   cd /home/ubuntu/multiflix-be
 *   pm2 start ecosystem.config.cjs
 *
 * Ensure `.env` exists here with at least MONGODB_URI, JWT_SECRET, and
 * REDIS_URL (the worker won't process jobs without Redis).
 *
 * Prereqs on the host (one-time):
 *   sudo apt update && sudo apt install -y ffmpeg redis-server
 *   sudo systemctl enable --now redis-server
 */
module.exports = {
  apps: [
    {
      name: 'multiflix-be',
      cwd: __dirname,
      script: 'dist/index.js',
      // Explicit fork mode — cluster mode (default for instances>1)
      // double-binds port 4000 and yields the EADDRINUSE crash loop you
      // see when a previous process hasn't released the port.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      // Background ffmpeg / S3 worker for Original Sound extraction.
      // Concurrency is set to 1 inside the worker itself so ffmpeg can't
      // starve the API even on a small instance. Restart memory ceiling
      // gives a buffer above peak (≈200 MB) for outliers.
      name: 'multiflix-worker',
      cwd: __dirname,
      script: 'dist/worker.js',
      // Worker doesn't bind a port; fork is the only sensible mode.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
