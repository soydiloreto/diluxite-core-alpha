// Tailwind v4: el plugin de PostCSS vive en su propio paquete
// (@tailwindcss/postcss). Reemplaza al "tailwindcss" directo que usabamos
// en v3. autoprefixer se mantiene como antes.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
