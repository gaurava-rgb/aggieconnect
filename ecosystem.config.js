module.exports = {
    apps: [
        {
            name: 'aggie-bot',
            script: 'bot.js',
            restart_delay: 5000,
            max_restarts: 10,
            autorestart: true,
            watch: false,
            env: { NODE_ENV: 'production' },
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
        },
        {
            name: 'aggie-dash',
            script: 'dashboard.js',
            restart_delay: 3000,
            max_restarts: 10,
            autorestart: true,
            watch: false,
            env: { NODE_ENV: 'production' },
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
        },
        {
            name: 'aggie-monitor',
            script: 'monitor.js',
            restart_delay: 3000,
            max_restarts: 10,
            autorestart: true,
            watch: false,
            env: { NODE_ENV: 'production' },
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
        }
    ]
};
