/// Normalizes an exact HTTPS URL or origin to canonical `https://host[:port]` form.
///
/// Rejects non-HTTPS schemes (`http:`, `file:`, `data:`, `about:`, opaque origins),
/// embedded credentials, wildcards, and malformed hosts (protocol S3/S4).
String? canonicalHttpsOrigin(String? input) {
  if (input == null) return null;
  final trimmed = input.trim();
  if (trimmed.isEmpty) return null;
  if (!trimmed.toLowerCase().startsWith('https://')) return null;

  final uri = Uri.tryParse(trimmed);
  if (uri == null ||
      uri.scheme != 'https' ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.host.contains('*')) {
    return null;
  }

  final host = uri.host.toLowerCase();
  if (uri.hasPort) {
    if (uri.port < 1 || uri.port > 65535) return null;
    if (uri.port != 443) return 'https://$host:${uri.port}';
  }
  return 'https://$host';
}

/// Exact HTTPS origin allowlist (protocol S3/S4). Never uses prefix or substring matching.
class OriginAllowlist {
  final Set<String> _origins;

  OriginAllowlist._(this._origins);

  /// Creates an allowlist from one or more bare exact HTTPS origins (`https://host[:port]`).
  ///
  /// Throws [ArgumentError] if [origins] is empty or contains any non-HTTPS,
  /// wildcard, credentialed, or path/query/fragment entry.
  factory OriginAllowlist(Iterable<String> origins) {
    final canonical = <String>{};
    for (final raw in origins) {
      final normalized = canonicalHttpsOrigin(raw);
      if (normalized == null) {
        throw ArgumentError.value(
          raw,
          'origins',
          'Expected exact https://host[:port] origin',
        );
      }
      final uri = Uri.parse(raw.trim());
      if ((uri.path.isNotEmpty && uri.path != '/') ||
          uri.hasQuery ||
          uri.hasFragment) {
        throw ArgumentError.value(
          raw,
          'origins',
          'Origin must not include path, query, or fragment',
        );
      }
      if (raw.trim().endsWith('/') && raw.trim() != '$normalized/') {
        throw ArgumentError.value(
          raw,
          'origins',
          'Expected exact https://host[:port] origin',
        );
      }
      canonical.add(normalized);
    }
    if (canonical.isEmpty) {
      throw ArgumentError.value(
        origins,
        'origins',
        'allowedOrigins must contain at least one exact HTTPS origin',
      );
    }
    return OriginAllowlist._(Set<String>.unmodifiable(canonical));
  }

  /// Canonical allowed HTTPS origins.
  Set<String> get origins => _origins;

  /// Returns true iff [origin] normalizes to an exact allowed HTTPS origin.
  bool allowsOrigin(String? origin) {
    final normalized = canonicalHttpsOrigin(origin);
    return normalized != null && _origins.contains(normalized);
  }

  /// Returns true iff [uri] normalizes to an exact allowed HTTPS origin.
  bool allowsUri(Uri? uri) => uri != null && allowsOrigin(uri.toString());

  /// Returns true iff [url] normalizes to an exact allowed HTTPS origin.
  bool allowsUrl(String? url) => allowsOrigin(url);
}
