// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveValue, …)
// at *runtime* for component specs. Harmless for the node-environment specs that
// never touch the DOM. The matching type declarations live in src/testing-library.d.ts
// (this file is outside tsconfig `include`, so it can't supply types itself).
import '@testing-library/jest-dom/vitest';
