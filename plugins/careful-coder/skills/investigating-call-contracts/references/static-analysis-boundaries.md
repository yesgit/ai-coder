# Static Analysis Boundaries

Use static results as a lower bound on known relationships, not proof that no other runtime relationship exists.

## React and UI components

- Follow JSX spread props to the object definition and record the keys that can reach the target.
- Follow wrapper components, render props, higher-order components, context providers, portals, and lazy/dynamic imports.
- Treat conditional rendering, route guards, feature flags, loading state, and permission state as caller preconditions.
- Inspect callback props in both directions: where the callback is supplied and where the target invokes it.

## Functions and services

- Follow callbacks passed to timers, promises, array operators, event emitters, queues, middleware, and framework registries.
- Resolve dependency-injection tokens to registrations and implementations.
- Search string keys used by command maps, route maps, serializers, reflection, or plugin registries.
- Check generated sources and package exports when the target is public outside the current package.

## Completeness escalation

Request runtime evidence when static resolution cannot determine the invoked implementation or parameter values. Prefer an existing focused test. Otherwise add temporary instrumentation only when project policy permits it, remove it afterward, and retain the command/output as evidence.

When runtime execution covers only one path, state exactly which path it proves. It does not prove that unexecuted paths are absent.
