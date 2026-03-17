module.exports = {
  apps: [{
    name: 'offshore-terminal',
    script: 'dist/index.js',
    cwd: '/opt/offshore-terminal',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    // Logs
    error_file: '/opt/offshore-terminal/logs/error.log',
    out_file: '/opt/offshore-terminal/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Restart policy
    exp_backoff_restart_delay: 1000,
    max_restarts: 50,
  }],
};
