import '@testing-library/jest-dom/vitest';

// jsdom no implementa canvas; devolvemos null (GraphView ya lo contempla) para evitar ruido.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
