module.exports = {
    apps: [{
        name: "luna-backend",
        script: "npm",
        args: "run dev",
        instances: 1,
        exec_mode: "fork",
        env: {
            NODE_ENV: "development",
        }
    }]
}