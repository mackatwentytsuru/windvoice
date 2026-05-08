// Tiny env helper so we don't need @electron-toolkit/utils.
export const is = {
  dev: process.env['NODE_ENV'] === 'development' || !!process.env['ELECTRON_RENDERER_URL']
};
