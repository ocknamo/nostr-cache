// Registers the @testing-library/jest-dom matcher types (toBeInTheDocument, …)
// on vitest's `expect` for type-checking the component specs. The runtime
// counterpart is imported in vitest.setup.ts.
import '@testing-library/jest-dom/vitest';
