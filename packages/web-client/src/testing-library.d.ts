// Registers the @testing-library/jest-dom matcher *types* (toBeInTheDocument, …)
// on vitest's `expect` for type-checking the component specs. Kept separate from
// the runtime registration in vitest.setup.ts because that setup file lives
// outside tsconfig `include` (src/** only) and so never contributes types.
import '@testing-library/jest-dom/vitest';
