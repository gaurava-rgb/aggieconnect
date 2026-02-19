module.exports = {
    apps: [{
        name: 'aggie-bot',
        script: 'bot.js',
        restart_delay: 5000,
        max_restarts: 10,
        autorestart: true,
        watch: false,
        env: {
            NODE_ENV: 'production'
        }
    }]
};
