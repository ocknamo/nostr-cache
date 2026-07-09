// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveValue, …)
// for component specs. Harmless for the node-environment specs that never touch the DOM.
import '@testing-library/jest-dom/vitest';
