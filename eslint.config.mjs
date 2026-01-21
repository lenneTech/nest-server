import baseConfig from '@lenne.tech/eslint-config-ts';

// Ignore templates - they contain placeholder code
const ignores = {
  ignores: ['src/core/modules/migrate/templates/migration-project.template.ts']
};

// Patch rules
const patched = baseConfig.map(config => {
  if (config.rules?.['unused-imports/no-unused-vars']) {
    config.rules['unused-imports/no-unused-vars'] = [
      'warn',
      {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      },
    ];
  }
  return config;
});

// Add new rule to an existing plugin
const customRules = patched.map(config => {
  if (config.plugins?.['@typescript-eslint']) {
    config.rules['@typescript-eslint/no-unused-expressions'] = [
      "warn",
      { "allowShortCircuit": true, "allowTernary": true }
    ];
  }
  return config;
});

// Export the modified config with ignores at the beginning
export default [ignores, ...customRules];
