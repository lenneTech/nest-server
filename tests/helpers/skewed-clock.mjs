/**
 * Preloaded (`--import`) into a server process of the clock-skew suite: the process's clock runs
 * `SYNC_CLOCK_SKEW_MS` milliseconds ahead (or behind, when negative) — `Date.now()`, `new Date()` and `Date()`, i.e.
 * everything an application reads its time from. The databases keep their own clock; the offline-sync protocol must not
 * depend on the application's (protocol §5.3).
 */
const skew = Number(process.env.SYNC_CLOCK_SKEW_MS) || 0;

if (skew) {
  const RealDate = Date;
  // A function rather than a subclass: `Date()` without `new` must keep answering a string
  function SkewedDate(...args) {
    if (!new.target) {
      return new RealDate(RealDate.now() + skew).toString();
    }
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + skew);
  }
  // Libraries resolve a schema type by the constructor's name (Mongoose: `Date` → its Date type)
  Object.defineProperty(SkewedDate, 'name', { value: 'Date' });
  SkewedDate.prototype = RealDate.prototype;
  // …and decide "class or type factory" by `prototype.constructor` (`@UnifiedField({ type: Date })`)
  Object.defineProperty(RealDate.prototype, 'constructor', { configurable: true, value: SkewedDate, writable: true });
  SkewedDate.now = () => RealDate.now() + skew;
  SkewedDate.parse = RealDate.parse;
  SkewedDate.UTC = RealDate.UTC;
  globalThis.Date = SkewedDate;
}
