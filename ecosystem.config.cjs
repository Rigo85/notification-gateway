module.exports = {
  apps: [
    {
      name: 'notification-gateway',
      script: 'dist/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
    },
  ],
};
