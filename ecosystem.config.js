module.exports = {
  apps: [
    {
      name: "hualink-api",
      script: "server.js",
      instances: "max", // Utilizes all available CPU cores in cluster mode
      exec_mode: "cluster",
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      max_memory_restart: "500M",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,
      time: true,
      autorestart: true,
      watch: false,
    },
  ],
};