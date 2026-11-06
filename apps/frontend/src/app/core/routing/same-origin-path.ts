/**
 * True when `value` is a same-origin relative path, safe to redirect to.
 *
 * Accepts `/dashboard?x=1`. Rejects anything that leaves the origin or that a
 * browser or the router could read as one: absolute URLs, protocol-relative
 * `//host`, backslash forms that browsers normalise to `//`, and control
 * characters that could split a header.
 */
export function isSameOriginPath(value: string | null | undefined): value is string {
  if (!value || !value.startsWith('/')) {
    return false;
  }
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return false;
  }
  return !/[\\\u0000-\u001f\u007f]/.test(value);
}
