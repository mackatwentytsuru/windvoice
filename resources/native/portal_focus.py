"""Best-effort focused application lookup for GNOME Wayland."""


def _unpack(value):
    while hasattr(value, 'unpack'):
        value = value.unpack()
    return value


def focused_app_id(get_windows):
    """Return GNOME Shell Introspect's focused app-id, or ``unknown``.

    GetWindows is normally restricted. AccessDenied and every other lookup or
    shape error are intentionally non-fatal because focus logging must never
    interfere with paste delivery.
    """
    try:
        windows = _unpack(get_windows())
        if isinstance(windows, tuple) and len(windows) == 1:
            windows = _unpack(windows[0])
        if not isinstance(windows, dict):
            return 'unknown'
        for raw_properties in windows.values():
            properties = _unpack(raw_properties)
            if not isinstance(properties, dict):
                continue
            has_focus = _unpack(
                properties.get('has-focus', properties.get('has_focus', False))
            )
            if not bool(has_focus):
                continue
            app_id = _unpack(
                properties.get('app-id', properties.get('app_id', ''))
            )
            if isinstance(app_id, str) and app_id:
                return app_id
    except Exception:  # noqa: BLE001 — best-effort observability only
        pass
    return 'unknown'
