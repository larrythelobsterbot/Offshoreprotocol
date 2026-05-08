module.exports = {
  apps: [{
    name: 'offshore-terminal',
    script: 'dist/index.js',
    cwd: '/home/muffinman/Offshoreprotocol',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '768M',
    env: {
      NODE_ENV: 'production',
      PORT: 3456,
      WALLET_ADDRESS: '0x30C620cf1fbC38083FfE2c645Fb45d7FE487e194',
      // Tunable economics knobs (override here without redeploy):
      // BASE_REWARD_DIRTY: '100',
      // FAILURE_REWARD_FRACTION_ARMS: '0.5',
      // FAILURE_REWARD_FRACTION_DRUG: '0.5',
    },
    // Logs
    error_file: '/home/muffinman/Offshoreprotocol/logs/error.log',
    out_file: '/home/muffinman/Offshoreprotocol/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Restart policy
    exp_backoff_restart_delay: 1000,
    max_restarts: 50,
  }],
};
