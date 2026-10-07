import { useLayoutEffect, useRef } from "react";

// A ref that always holds the latest value, for event handlers and
// subscriptions that must not be re-created when the value changes.
export function useLatest<T>(value: T) {
  const ref = useRef(value);

  useLayoutEffect(() => {
    ref.current = value;
  });

  return ref;
}
