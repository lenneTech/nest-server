module.exports = {
  /**
   * Application configuration section
   * http://pm2.keymetrics.io/docs/usage/application-declaration/
   */
  apps: [
    // Nest Server
    {
      'name': 'nest',
      'script': 'dist/main.js',
      'env': {
        'NODE_ENV': 'development',
      },
      'env_production': {
        'NODE_ENV': 'production',
      },
      'watch': ['dist'],
      'ignore_watch': ['public'],
      'watch_options': {
        'followSymlinks': false,
      },
    },
  ],
};
