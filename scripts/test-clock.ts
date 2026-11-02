const DAY_MS = 86_400_000

// Keep time moving and leave timers alone: only wall-clock reads are offset.
// Explicit Date/Temporal fixtures retain their original meaning.
export function offsetTestClock(days: string | undefined): () => void {
  if (days === undefined) return () => {}
  const offset = Number(days) * DAY_MS
  if (days.trim() === '' || !Number.isSafeInteger(offset)) {
    throw new Error('HOURMERE_TEST_CLOCK_OFFSET_DAYS must be a finite number of days')
  }

  const RealDate = globalThis.Date
  const realNow = Temporal.Now
  function ClockDate() {
    return new RealDate(RealDate.now() + offset).toString()
  }
  // Preserve native/pg Date instances and Date.prototype identity.
  // An own `now` also lets a local spy override it without mutating RealDate.
  Object.setPrototypeOf(ClockDate, RealDate)
  Object.defineProperty(ClockDate, 'name', { value: RealDate.name })
  Object.defineProperty(ClockDate, 'length', { value: RealDate.length })
  Object.defineProperty(ClockDate, 'prototype', { value: RealDate.prototype })
  Object.defineProperty(ClockDate, 'now', {
    configurable: true,
    writable: true,
    value: () => RealDate.now() + offset,
  })
  globalThis.Date = new Proxy(ClockDate, {
    construct(_target, args, newTarget) {
      return Reflect.construct(RealDate, args.length ? args : [RealDate.now() + offset], newTarget)
    },
    apply() {
      return new RealDate(RealDate.now() + offset).toString()
    },
  }) as unknown as DateConstructor
  const instant = () => realNow.instant().add({ milliseconds: offset })
  const zonedDateTimeISO = (zone: Temporal.TimeZoneLike = realNow.timeZoneId()) =>
    instant().toZonedDateTimeISO(zone)
  Temporal.Now = {
    ...realNow,
    instant,
    timeZoneId: () => realNow.timeZoneId(),
    zonedDateTimeISO,
    plainDateTimeISO: (zone) => zonedDateTimeISO(zone).toPlainDateTime(),
    plainDateISO: (zone) => zonedDateTimeISO(zone).toPlainDate(),
    plainTimeISO: (zone) => zonedDateTimeISO(zone).toPlainTime(),
  }
  return () => {
    globalThis.Date = RealDate
    Temporal.Now = realNow
  }
}
