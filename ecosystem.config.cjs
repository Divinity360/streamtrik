module.exports = {
  apps: [{
    name: 'streamtrik-proxy',
    script: './proxy.js',
    cwd: '/home/administrator/streamtrik',
    instances: 1,
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production' },
  }],
};
