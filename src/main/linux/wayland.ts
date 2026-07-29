// Session-type detection for the Linux backends.
//
// WAYLAND_DISPLAY is the primary signal (set for every Wayland session,
// including when the app itself runs as an XWayland client); XDG_SESSION_TYPE
// is the fallback for exotic launch environments that scrub WAYLAND_DISPLAY.

export function isWaylandSession(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env['WINDVOICE_FORCE_X11'] === '1') return false;
  return (
    Boolean(process.env['WAYLAND_DISPLAY']) || process.env['XDG_SESSION_TYPE'] === 'wayland'
  );
}
