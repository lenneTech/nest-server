module.exports = function (grunt) {

  // Load plugins
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-sync');
  grunt.loadNpmTasks('grunt-bg-shell');
  grunt.loadNpmTasks('grunt-contrib-watch');

  // Init Config
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    // CleanUp build
    clean: {
      buildFolder: ["dist"]
    },

    // Copy templates
    sync: {
      templates: {
        files: [
          {cwd: 'src/templates', src: ['**'], dest: 'dist/templates/'},
        ],
        verbose: true,
        failOnError: true,
        updateAndDelete: true
      },
    },

    // NonGrunt watcher
    bgShell: {
      _defaults: {
        bg: true
      },

      // Typescript compiler
      tsc: {
        cmd: 'node_modules/.bin/tsc -p tsconfig.build.json',
        bg: false
      },

      // Typescript compiler + watch
      tscWatch: {
        cmd: 'node_modules/.bin/tsc -w -p tsconfig.build.json'
      },

      // Restart server
      pm2: {
        cmd: 'node_modules/.bin/pm2 startOrRestart pm2.config.js',
        bg: false
      },

      // Restart server
      pm2Prod: {
        cmd: 'node_modules/.bin/pm2 startOrRestart pm2.config.js --env production',
        bg: false
      },
    },

    // Watch for file changes
    watch: {
      templates: {
        files: 'src/templates/**/*',
        tasks: ['sync:templates']
      }
    }
  });
  grunt.event.on('watch', function(action, filepath, target) {
    grunt.log.writeln(target + ': ' + filepath + ' has ' + action);
  });

  // Register tasks
  grunt.registerTask('default', ['clean:buildFolder', 'bgShell:tsc', 'sync', 'bgShell:tscWatch', 'bgShell:pm2', 'watch']);
  grunt.registerTask('productive', ['clean:buildFolder', 'bgShell:tsc', 'sync', 'bgShell:tscWatch', 'bgShell:pm2Prod', 'watch']);
  grunt.registerTask('build', ['clean:buildFolder', 'sync', 'bgShell:parsLocales', 'bgShell:tsc']);
}
