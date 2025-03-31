import typescript from '@lenne.tech/eslint-config-ts'

export default [
  ...typescript,
  {
    rules: {
      "unused-imports/no-unused-vars": [
        "warn",
        {
          "caughtErrors": "none"
        },
      ],
      "@typescript-eslint/no-unused-expressions": [
        "warn",
        { "allowShortCircuit": true, "allowTernary": true }
      ],
    }
  }
]
