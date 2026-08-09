import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest.config.ts does not set `test.globals`, so React Testing Library's auto-cleanup never
// self-registers (it only does that when it finds a global `afterEach`). Registering it here,
// once, repo-wide, replaces the same `afterEach(cleanup)` boilerplate every component test file
// was otherwise repeating for itself.
afterEach(cleanup)
