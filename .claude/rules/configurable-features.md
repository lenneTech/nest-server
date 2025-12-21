# Configurable Features Pattern

This document describes the standard pattern for implementing optional, configurable features in @lenne.tech/nest-server.

## "Presence Implies Enabled" Pattern

When implementing configurable features, follow this pattern for activation logic:

### Rules

1. **No configuration** (`undefined` or `null`): Feature is **disabled** (backward compatible)
2. **Empty object** (`{}`): Feature is **enabled** with all default values
3. **Partial configuration** (`{ max: 5 }`): Feature is **enabled**, missing values use defaults
4. **Explicit disable** (`{ enabled: false, ... }`): Feature is **disabled**, allows pre-configuration

### Benefits

- **Backward Compatible**: Existing projects without config continue to work unchanged
- **Efficient**: No need to set `enabled: true` redundantly when already providing config
- **Flexible**: Can pre-configure without activating via `enabled: false`
- **Intuitive**: Providing a config object signals intent to use the feature

### Implementation Example

```typescript
interface IFeatureConfig {
  enabled?: boolean;  // Optional - presence of config implies true
  max?: number;
  windowSeconds?: number;
}

const DEFAULT_CONFIG: Required<IFeatureConfig> = {
  enabled: false,  // Default is false, but overridden by presence
  max: 10,
  windowSeconds: 60,
};

class FeatureService {
  private config: Required<IFeatureConfig> = DEFAULT_CONFIG;

  /**
   * Configure the feature
   *
   * Follows the "presence implies enabled" pattern:
   * - If config is undefined/null: feature stays disabled (backward compatible)
   * - If config is an object (even empty {}): feature is enabled by default
   * - Unless `enabled: false` is explicitly set
   */
  configure(config: IFeatureConfig | undefined | null): void {
    // No config = stay disabled (backward compatible)
    if (config === undefined || config === null) {
      return;
    }

    // Presence of config implies enabled, unless explicitly disabled
    const enabled = config.enabled !== false;

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled,
    };
  }
}
```

### Usage Examples

```typescript
// config.env.ts

// Feature disabled (no config)
// rateLimit: undefined  // or just don't define it

// Feature enabled with all defaults
auth: {
  rateLimit: {}
}

// Feature enabled with custom max
auth: {
  rateLimit: { max: 20 }
}

// Feature enabled with full configuration
auth: {
  rateLimit: {
    max: 10,
    windowSeconds: 60,
    message: 'Too many requests'
  }
}

// Pre-configured but disabled (for testing or gradual rollout)
auth: {
  rateLimit: {
    enabled: false,
    max: 10,
    windowSeconds: 60
  }
}
```

## Applied Features

This pattern is currently applied to:

| Feature | Config Path | Default Values |
|---------|-------------|----------------|
| Legacy Auth Rate Limiting | `auth.rateLimit` | `max: 10`, `windowSeconds: 60` |
| BetterAuth Rate Limiting | `betterAuth.rateLimit` | `max: 10`, `windowSeconds: 60` |

## Checklist for New Configurable Features

When adding a new configurable feature:

- [ ] Define interface with `enabled?: boolean` as optional property
- [ ] Set `enabled: false` in DEFAULT_CONFIG
- [ ] Implement "presence implies enabled" logic in configure method
- [ ] Document all default values in interface JSDoc
- [ ] Add tests for: undefined config, empty object, partial config, explicit disable
- [ ] Update this document with the new feature
